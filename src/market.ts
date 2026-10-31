import {boundedJson} from './http.ts';
import {constructPaymentHeaders,type PaymentHeaders} from '@bsv/402-pay/client';
import {Transaction,Utils,type WalletInterface} from '@bsv/sdk';
import {validatePayment,type PaymentQuote,type PaymentApproval} from './index.ts';
import {IndexedDBOperationJournal} from './journal.ts';
import {canonical,reportCommitment,reportDigest,type PublishedReport} from './report-contract.ts';
import type {MintReceipt,MintIntent} from './mint.ts';
import type {SwapOffer} from './swap.ts';
export interface ReportQuote extends PaymentQuote {reportId:string;title:string}
export interface PurchaseRecord {status:'pending'|'wallet_broadcast'|'merchant_accepted'|'review_required';quote:ReportQuote;payment?:PaymentHeaders;txid?:string}
export class IndexedDBPurchaseJournal extends IndexedDBOperationJournal<PurchaseRecord>{constructor(name='ocnif-purchases'){super(name);}}
export type PurchaseJournal=Pick<IndexedDBPurchaseJournal,'reserve'|'get'|'update'>;
export interface PurchaseResult {report:PublishedReport;payment:{accepted:true;txid:string;satoshisPaid:number;senderIdentityKey:string};confirmed:false}
function serviceUrl(baseUrl:string):string {const p=new URL(baseUrl);if(p.username||p.password||p.search||p.hash||(p.protocol!=='https:'&&!(p.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(p.hostname))))throw Error('invalid_market_url');return p.href.replace(/\/$/,'');}
/** One explicit wallet payment. Network errors retain its proof; they never trigger another payment. */
export async function purchasePublishedReport(wallet:WalletInterface,baseUrl:string,quote:ReportQuote,approval:PaymentApproval,journal:PurchaseJournal):Promise<PurchaseResult>{
 validatePayment(quote,approval);const base=serviceUrl(baseUrl);
 const [{network},{publicKey}]=await Promise.all([wallet.getNetwork({}),wallet.getPublicKey({identityKey:true})]);
 if(network!==quote.network)throw Error('wallet_network_mismatch');
 const key=`purchase:${publicKey}:${quote.id}`;await journal.reserve(key,{status:'pending',quote});
 let proof:PaymentHeaders|undefined;let txid:string|undefined;
 try{
  const commitment=reportCommitment(quote.reportDigest);
  // BRC-121 currently passes a scheme in the BRC-100 originator. Normalize it
  // for Wallet Toolbox and add a report binding before the user signs.
  const bound=new Proxy(wallet,{get(target,prop){const value=Reflect.get(target,prop);if(typeof value!=='function')return value;
   return async(args:any,originator?:string)=>{
    const origin=originator?.replace(/^[a-z][a-z0-9+.-]*:\/\//i,'');
    if(prop!=='createAction')return value.call(target,args,origin);
    validatePayment(quote,approval);
    const result=await target.createAction({...args,outputs:[...args.outputs,{satoshis:0,lockingScript:commitment,outputDescription:'Published report digest'}],options:{...args.options,acceptDelayedBroadcast:false,returnTXIDOnly:false}},origin);
    if(!result.tx||!result.txid||result.signableTransaction||result.sendWithResults?.some(x=>x.status==='failed'||x.status==='sending'))throw Error('payment_broadcast_uncertain');
    const tx=Transaction.fromAtomicBEEF(result.tx);
    if(tx.id('hex')!==result.txid||!tx.outputs.some(x=>x.satoshis===0&&x.lockingScript.toHex()===commitment)||tx.outputs[0]?.satoshis!==quote.satoshis||tx.outputs[0]?.lockingScript.toHex()!==args.outputs[0].lockingScript)throw Error('payment_wallet_mismatch');
    txid=result.txid;return result;
   };}});
  proof=await constructPaymentHeaders(bound,`${base}/v1/quotes/${quote.id}/pay`,quote.satoshis,quote.recipientIdentityKey);
  await journal.update(key,{status:'wallet_broadcast',quote,payment:proof,txid});
  return await deliver(base,quote,key,proof,txid!,journal);
 }catch(error){await journal.update(key,{status:'review_required',quote,payment:proof,txid});throw error;}
}
async function deliver(base:string,quote:ReportQuote,key:string,payment:PaymentHeaders,txid:string,journal:PurchaseJournal):Promise<PurchaseResult>{
 const response=await fetch(`${base}/v1/quotes/${quote.id}/pay`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payment}),redirect:'error',signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error(`report_delivery_http_${response.status}`);
 const result=await boundedJson(response) as PurchaseResult;
 if(!result?.payment?.accepted||result.payment.txid!==txid||result.payment.satoshisPaid!==quote.satoshis||result.report?.id!==quote.reportId||reportDigest(result.report)!==quote.reportDigest)throw Error('report_delivery_mismatch');
 await journal.update(key,{status:'merchant_accepted',quote,payment,txid});return result;
}
export interface PassRegistration {intent:MintIntent;tokenId:string;outpoint:string}
export interface SignedPassRegistration {registration:PassRegistration;signature:number[]}
export const PASS_PROTOCOL=[2,'ocnif report pass'] as const;
export const ACCESS_PROTOCOL=[2,'ocnif report access'] as const;
export interface AccessChallenge {id:string;reportId:string;reportDigest:string;outpoint:string;holderIdentityKey:string;keyIndex:number;expiresAt:number}
export async function signPassRegistration(wallet:WalletInterface,receipt:MintReceipt):Promise<SignedPassRegistration>{
 if(receipt.status!=='overlay_admitted'||(await wallet.getPublicKey({identityKey:true})).publicKey!==receipt.intent.issuerIdentityKey)throw Error('pass_not_ready');
 const registration={intent:receipt.intent,tokenId:receipt.tokenId,outpoint:receipt.outpoint};
 const {signature}=await wallet.createSignature({protocolID:[...PASS_PROTOCOL],keyID:receipt.intent.id,counterparty:'anyone',data:Utils.toArray(canonical(registration),'utf8')});return {registration,signature};
}
export async function signReportAccess(wallet:WalletInterface,challenge:AccessChallenge):Promise<{challengeId:string;signature:number[]}>{
 if(challenge.expiresAt<=Date.now()||(await wallet.getPublicKey({identityKey:true})).publicKey!==challenge.holderIdentityKey)throw Error('access_challenge_mismatch');
 const {signature}=await wallet.createSignature({protocolID:[...ACCESS_PROTOCOL],keyID:challenge.id,counterparty:'anyone',data:Utils.toArray(canonical(challenge),'utf8')});return {challengeId:challenge.id,signature};
}

export const OFFER_PROTOCOL=[2,'ocnif report offer'] as const;
export interface ReportOffer {reportId:string;reportDigest:string;offer:SwapOffer}
export async function signReportOffer(wallet:WalletInterface,offer:ReportOffer):Promise<{listing:ReportOffer;signature:number[]}>{
 if((await wallet.getPublicKey({identityKey:true})).publicKey!==offer.offer.sellerIdentityKey||(await wallet.getNetwork({})).network!==offer.offer.network)throw Error('offer_wallet_mismatch');
 const {signature}=await wallet.createSignature({protocolID:[...OFFER_PROTOCOL],keyID:offer.offer.id,counterparty:'anyone',data:Utils.toArray(canonical(offer),'utf8')});return {listing:offer,signature};
}
