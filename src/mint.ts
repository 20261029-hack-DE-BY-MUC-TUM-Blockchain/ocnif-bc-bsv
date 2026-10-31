import {LockingScript,OP,P2PKH,Script,Transaction,Utils,type WalletInterface,type WalletNetwork} from '@bsv/sdk';
import {IndexedDBOperationJournal} from './journal.ts';
import {TOKEN_PROTOCOL,readToken,tokenOwner} from './token.ts';
import {reportCommitment} from './report-contract.ts';
import type {TokenOverlay} from './swap.ts';
export interface MintIntent {id:string;reportId:string;reportDigest:string;issuerIdentityKey:string;network:WalletNetwork;keyIndex:number}
export interface MintReceipt {status:'overlay_admitted'|'overlay_pending';confirmed:false;intent:MintIntent;tokenId:string;outpoint:string;transaction:number[];txid:string}
export interface MintRecord {status:'pending'|'review_required'|'overlay_admitted'|'overlay_pending';intent:MintIntent;receipt?:MintReceipt}
export class IndexedDBMintJournal extends IndexedDBOperationJournal<MintRecord> {constructor(name='ocnif-mints'){super(name);}}
export type MintJournal=Pick<IndexedDBMintJournal,'reserve'|'update'|'get'>;
function validate(intent:MintIntent,approval:MintIntent) {
  for(const field of ['id','reportId','reportDigest','issuerIdentityKey','network','keyIndex'] as const)if(intent[field]!==approval[field])throw new Error('mint_approval_mismatch');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(intent.id)||!/^[A-Za-z0-9_-]{1,100}$/.test(intent.reportId)||!['mainnet','testnet'].includes(intent.network))throw new Error('invalid_mint_intent');
  reportCommitment(intent.reportDigest);tokenOwner(intent.issuerIdentityKey,intent.keyIndex);
}
export async function mintReportPass(wallet:WalletInterface,intent:MintIntent,approval:MintIntent,overlay:TokenOverlay,journal:MintJournal):Promise<MintReceipt> {
  validate(intent,approval);const [{network},{publicKey}]=await Promise.all([wallet.getNetwork({}),wallet.getPublicKey({identityKey:true})]);
  if(network!==intent.network||publicKey!==intent.issuerIdentityKey)throw new Error('issuer_wallet_mismatch');
  const key=`mint:${publicKey}:${intent.id}`;await journal.reserve(key,{status:'pending',intent});
  try {
    const body=JSON.stringify({p:'bsv-20',op:'deploy+mint',amt:'1',sym:'OCNIF',dec:'0'});
    const envelope=new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_IF).writeBin(Utils.toArray('ord','utf8')).writeOpCode(OP.OP_1).writeBin(Utils.toArray('application/bsv-20','utf8')).writeOpCode(OP.OP_0).writeBin(Utils.toArray(body,'utf8')).writeOpCode(OP.OP_ENDIF);
    const script=LockingScript.fromHex(envelope.toHex()+new P2PKH().lock(Utils.toArray(tokenOwner(publicKey,intent.keyIndex),'hex')).toHex()).toHex();
    const commitment=reportCommitment(intent.reportDigest);
    const action=await wallet.createAction({description:'Mint one approved report access pass',outputs:[
      {satoshis:1,lockingScript:script,outputDescription:'One transferable report access pass',basket:'bsv21',customInstructions:JSON.stringify({protocolID:TOKEN_PROTOCOL,keyID:String(intent.keyIndex),counterparty:'anyone',index:intent.keyIndex})},
      {satoshis:0,lockingScript:commitment,outputDescription:'Published report digest'}],options:{randomizeOutputs:false,acceptDelayedBroadcast:false,returnTXIDOnly:false}});
    if(!action.txid||!action.tx||action.signableTransaction)throw new Error('mint_wallet_result_incomplete');
    const tx=Transaction.fromAtomicBEEF(action.tx);
    if(tx.id('hex')!==action.txid||tx.outputs[0]?.lockingScript.toHex()!==script||tx.outputs[0].satoshis!==1||!tx.outputs.some(x=>x.satoshis===0&&x.lockingScript.toHex()===commitment))throw new Error('mint_wallet_result_mismatch');
    if(action.sendWithResults?.some(x=>x.status==='failed'||x.status==='sending'))throw new Error('mint_broadcast_uncertain');
    const receipt:MintReceipt={status:'overlay_pending',confirmed:false,intent,tokenId:`${action.txid}_0`,outpoint:`${action.txid}.0`,transaction:Array.from(action.tx),txid:action.txid};
    await journal.update(key,{status:'overlay_pending',intent,receipt});return await reconcileMint(wallet,receipt,overlay,journal);
  }catch(error){const saved=await journal.get(key);if(!saved?.receipt)await journal.update(key,{status:'review_required',intent});throw error;}
}
export async function reconcileMint(wallet:WalletInterface,receipt:MintReceipt,overlay:TokenOverlay,journal:MintJournal):Promise<MintReceipt> {
  const {publicKey}=await wallet.getPublicKey({identityKey:true});const key=`mint:${publicKey}:${receipt.intent.id}`;
  const saved=await journal.get(key);if(publicKey!==receipt.intent.issuerIdentityKey||!saved?.receipt||JSON.stringify(saved.receipt)!==JSON.stringify(receipt))throw new Error('mint_receipt_not_recorded');
  const reconciled={...receipt};
  try {
    await overlay.submit(receipt.transaction);const admitted=await overlay.lookup(receipt.outpoint);
    const token=admitted&&readToken(admitted.transaction.outputs[admitted.outputIndex].lockingScript,receipt.outpoint);
    if(!admitted||admitted.spent||token?.id!==receipt.tokenId||token.amount!=='1'||token.ownerPkh!==tokenOwner(publicKey,receipt.intent.keyIndex))throw new Error('mint_not_admitted');
    reconciled.status='overlay_admitted';
  }catch{reconciled.status='overlay_pending';}
  await journal.update(key,{status:reconciled.status,intent:receipt.intent,receipt:reconciled});return reconciled;
}
