import {WalletClient,P2PKH,PublicKey,Random,Transaction,Utils,LockingScript,type WalletInterface,type WalletNetwork,type WalletProtocol} from '@bsv/sdk';
export {IndexedDBPaymentJournal} from './journal.ts';
export const BRC29_PROTOCOL:WalletProtocol=[2,'3241645161d8'];
export interface PaymentQuote {id:string;recipientIdentityKey:string;satoshis:number;network:WalletNetwork;expiresAt:number;reportDigest:string}
export interface PaymentApproval {id:string;recipientIdentityKey:string;maxSatoshis:number;network:WalletNetwork;reportDigest:string}
export interface PaymentReceipt {status:'wallet_broadcast';confirmed:false;quoteId:string;network:WalletNetwork;tx:number[];txid:string;outputIndex:number;satoshis:number;derivationPrefix:string;derivationSuffix:string;senderIdentityKey:string;reportDigest:string}
export interface PaymentRecord {status:'pending'|'wallet_broadcast'|'review_required';quote:PaymentQuote;receipt?:PaymentReceipt}
export interface PaymentJournal {reserve(key:string,record:PaymentRecord):Promise<void>;update(key:string,record:PaymentRecord):Promise<void>;get(key:string):Promise<PaymentRecord|undefined>}

export async function connectWallet(){
  const wallet=new WalletClient('auto');
  const authenticated=await wallet.isAuthenticated({});
  if(!authenticated.authenticated)throw new Error('wallet_authentication_required');
  const [{network},{publicKey:identityKey}]=await Promise.all([wallet.getNetwork({}),wallet.getPublicKey({identityKey:true})]);
  return {wallet,network,identityKey};
}
export function validatePayment(quote:PaymentQuote,approval:PaymentApproval,now=Date.now()):void{
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(quote.id)||quote.id!==approval.id)throw new Error('payment_intent_mismatch');
  if(!Number.isSafeInteger(quote.satoshis)||quote.satoshis<1||!Number.isSafeInteger(approval.maxSatoshis)||quote.satoshis>approval.maxSatoshis)throw new Error('payment_budget_exceeded');
  if(!Number.isSafeInteger(quote.expiresAt)||quote.expiresAt<=now)throw new Error('payment_quote_expired');
  if(!['mainnet','testnet'].includes(quote.network)||quote.network!==approval.network)throw new Error('payment_network_mismatch');
  if(!/^0[23][0-9a-fA-F]{64}$/.test(quote.recipientIdentityKey)||quote.recipientIdentityKey!==approval.recipientIdentityKey)throw new Error('payment_recipient_mismatch');
  PublicKey.fromString(quote.recipientIdentityKey);
  if(!/^[0-9a-f]{64}$/.test(quote.reportDigest)||quote.reportDigest!==approval.reportDigest)throw new Error('payment_report_mismatch');
}
export async function payForReport(wallet:WalletInterface,quote:PaymentQuote,approval:PaymentApproval,journal:PaymentJournal):Promise<PaymentReceipt>{
  validatePayment(quote,approval);
  const [{network},{publicKey:senderIdentityKey}]=await Promise.all([wallet.getNetwork({}),wallet.getPublicKey({identityKey:true})]);
  if(network!==quote.network)throw new Error('wallet_network_mismatch');
  const key=`${senderIdentityKey}:${quote.id}`;
  await journal.reserve(key,{status:'pending',quote});
  try{
    const derivationPrefix=Utils.toBase64(Random(16));const derivationSuffix=Utils.toBase64(Random(16));
    const {publicKey}=await wallet.getPublicKey({protocolID:BRC29_PROTOCOL,keyID:`${derivationPrefix} ${derivationSuffix}`,counterparty:quote.recipientIdentityKey,forSelf:false});
    const lockingScript=new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
    const commitment=LockingScript.fromASM(`OP_FALSE OP_RETURN ${Utils.toHex(Utils.toArray('ocnif-report','utf8'))} ${quote.reportDigest}`).toHex();
    validatePayment(quote,approval);
    const result=await wallet.createAction({description:'Ocnif approved report payment',outputs:[
      {lockingScript,satoshis:quote.satoshis,outputDescription:'Approved report recipient'},
      {lockingScript:commitment,satoshis:0,outputDescription:'Public report SHA256 commitment'},
    ],options:{randomizeOutputs:false,acceptDelayedBroadcast:false,returnTXIDOnly:false}});
    if(!result.txid||!result.tx||result.signableTransaction)throw new Error('wallet_payment_incomplete');
    const transaction=Transaction.fromAtomicBEEF(result.tx);
    if(transaction.id('hex')!==result.txid)throw new Error('wallet_transaction_mismatch');
    const outputIndex=transaction.outputs.findIndex(output=>output.lockingScript.toHex()===lockingScript&&output.satoshis===quote.satoshis);
    if(outputIndex<0||!transaction.outputs.some(output=>output.lockingScript.toHex()===commitment&&output.satoshis===0))throw new Error('wallet_output_mismatch');
    if(result.sendWithResults?.some(result=>result.status==='failed'||result.status==='sending'))throw new Error('wallet_broadcast_unconfirmed');
    const receipt:PaymentReceipt={status:'wallet_broadcast',confirmed:false,quoteId:quote.id,network,tx:Array.from(result.tx),txid:result.txid,outputIndex,satoshis:quote.satoshis,derivationPrefix,derivationSuffix,senderIdentityKey,reportDigest:quote.reportDigest};
    await journal.update(key,{status:'wallet_broadcast',quote,receipt});return receipt;
  }catch(error){await journal.update(key,{status:'review_required',quote});throw error;}
}
