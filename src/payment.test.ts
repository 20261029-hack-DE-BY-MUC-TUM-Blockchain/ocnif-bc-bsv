import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivateKey,Transaction,LockingScript,type CreateActionArgs,type WalletInterface} from '@bsv/sdk';
import {payForReport,validatePayment,type PaymentJournal,type PaymentRecord,type PaymentQuote,type PaymentApproval} from './index.ts';
const recipient=PrivateKey.fromString('1'.padStart(64,'0'),'hex').toPublicKey().toString();
const sender=PrivateKey.fromString('2'.padStart(64,'0'),'hex').toPublicKey().toString();
const quote:PaymentQuote={id:'report-payment-1',recipientIdentityKey:recipient,satoshis:10,network:'testnet',expiresAt:Date.now()+60000,reportDigest:'ab'.repeat(32)};
const approval:PaymentApproval={id:quote.id,recipientIdentityKey:recipient,maxSatoshis:10,network:'testnet',reportDigest:quote.reportDigest};
class Journal implements PaymentJournal {
  rows=new Map<string,PaymentRecord>();
  async reserve(key:string,record:PaymentRecord){if(this.rows.has(key))throw new Error('payment_already_attempted');this.rows.set(key,record);}
  async update(key:string,record:PaymentRecord){this.rows.set(key,record);}
  async get(key:string){return this.rows.get(key);}
}
function mockWallet(tamper=false){let actions=0;const wallet={getNetwork:async()=>({network:'testnet'}),getPublicKey:async(args:Record<string,unknown>)=>({publicKey:args.identityKey?sender:recipient}),createAction:async(args:CreateActionArgs)=>{
  actions++;const tx=new Transaction(1,[],args.outputs!.map((output,index)=>({satoshis:tamper&&index===0?output.satoshis+1:output.satoshis,lockingScript:LockingScript.fromHex(output.lockingScript!)})));
  return {txid:tx.id('hex'),tx:tx.toAtomicBEEF()};
}} as unknown as WalletInterface;return {wallet,actions:()=>actions};}

test('payment approval binds exact recipient, report, network, amount and expiry',()=>{
  validatePayment(quote,approval,Date.now());
  for(const changed of [{satoshis:11},{recipientIdentityKey:sender},{network:'mainnet' as const},{reportDigest:'cd'.repeat(32)},{expiresAt:0}])assert.throws(()=>validatePayment({...quote,...changed},approval,Date.now()));
});
test('wallet payment receipt matches real SDK transaction outputs and repeated intent cannot broadcast twice',async()=>{
  const mock=mockWallet();const journal=new Journal();const receipt=await payForReport(mock.wallet,quote,approval,journal);
  assert.equal(receipt.satoshis,10);assert.equal(receipt.status,'wallet_broadcast');assert.equal(receipt.confirmed,false);assert.equal(receipt.outputIndex,0);
  assert.equal(Transaction.fromAtomicBEEF(receipt.tx).id('hex'),receipt.txid);
  await assert.rejects(payForReport(mock.wallet,quote,approval,journal),/payment_already_attempted/);assert.equal(mock.actions(),1);
});
test('mismatched wallet output remains uncertain and can never be retried automatically',async()=>{
  const mock=mockWallet(true);const journal=new Journal();await assert.rejects(payForReport(mock.wallet,quote,approval,journal),/wallet_output_mismatch/);
  assert.equal([...journal.rows.values()][0]?.status,'review_required');
  await assert.rejects(payForReport(mock.wallet,quote,approval,journal),/payment_already_attempted/);assert.equal(mock.actions(),1);
});
