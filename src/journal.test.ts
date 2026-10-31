import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {IndexedDBPaymentJournal,type PaymentRecord} from './index.ts';

test('browser journal reserves an intent atomically across tabs and preserves status after reopen',async()=>{
  const name=`ocnif-test-${crypto.randomUUID()}`;const first=new IndexedDBPaymentJournal(name);const second=new IndexedDBPaymentJournal(name);
  const record:PaymentRecord={status:'pending',quote:{id:'quote',recipientIdentityKey:'02'+'11'.repeat(32),satoshis:10,network:'testnet',expiresAt:Date.now()+60000,reportDigest:'ab'.repeat(32)}};
  const results=await Promise.allSettled([first.reserve('wallet:quote',record),second.reserve('wallet:quote',record)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  await first.update('wallet:quote',{...record,status:'review_required'});
  const reopened=new IndexedDBPaymentJournal(name);assert.equal((await reopened.get('wallet:quote'))?.status,'review_required');
  await assert.rejects(reopened.reserve('wallet:quote',record));
});
