import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {Beef,PrivateKey,Transaction} from '@bsv/sdk';
import {startOverlay} from './overlay.ts';
import {loadConfig} from './config.ts';
import {createMockChain} from '../src/test-helpers/mockchain.ts';
import {HttpTokenOverlay} from '../src/overlay.ts';
import {mintReportPass,type MintRecord} from '../src/mint.ts';
import {prepareSwap,approveSwap,completeSwap,receiveSwapProceeds,type SwapRecord} from '../src/swap.ts';
import {transferScript,tokenOwner} from '../src/token.ts';
class Journal<T>{rows=new Map<string,T>();async reserve(k:string,v:T){if(this.rows.has(k))throw Error('duplicate');this.rows.set(k,v);}async update(k:string,v:T){this.rows.set(k,v);}async get(k:string){return this.rows.get(k);}}
async function freePort(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
test('real overlay validates mint ancestry, rejects forgery and admits one two-wallet atomic swap',async()=>{
 const chain=await createMockChain();const dir=mkdtempSync(join(tmpdir(),'ocnif-overlay-'));const port=await freePort();
 const config=loadConfig({OVERLAY_PRIVATE_KEY:PrivateKey.fromRandom().toHex(),INTERNAL_TOKEN:'test-only-not-a-production-token-1234',OVERLAY_PORT:String(port),OVERLAY_PUBLIC_URL:`http://127.0.0.1:${port}`,OVERLAY_DB:join(dir,'overlay.sqlite')});
 const server=await startOverlay(config,{chainTracker:chain.chainTracker,broadcaster:{async broadcast(tx){const txid=tx.id('hex');await chain.services.postBeef(Beef.fromBinary(tx.toBEEF()) as never,[txid]);return {status:'success',txid,message:'local mock chain'};}}});
 try {
  const seller=await chain.makeWallet(),buyer=await chain.makeWallet();await chain.fund(seller);await chain.fund(buyer);
  const issuerIdentityKey=(await seller.getPublicKey({identityKey:true})).publicKey;const buyerId=(await buyer.getPublicKey({identityKey:true})).publicKey;
  const network=(await seller.getNetwork({})).network;const intent={id:'mock-mint',reportId:'published-test',reportDigest:'a'.repeat(64),issuerIdentityKey,network,keyIndex:0};
  const overlay=new HttpTokenOverlay(config.overlayUrl);const mints=new Journal<MintRecord>();const mint=await mintReportPass(seller,intent,{...intent},overlay,mints);
  assert.equal(mint.status,'overlay_admitted');assert.equal((await overlay.lookup(mint.outpoint))?.spent,false);
  await assert.rejects(mintReportPass(seller,intent,{...intent},overlay,mints),/duplicate/);
  const forged=await buyer.createAction({description:'Mock token forgery boundary test',outputs:[{satoshis:1,lockingScript:transferScript({id:mint.tokenId,amount:'2',ownerPkh:tokenOwner(buyerId,0)}).toHex(),outputDescription:'Invalid token supply'}],options:{randomizeOutputs:false,acceptDelayedBroadcast:false}});
  assert.ok(forged.tx&&forged.txid);await assert.rejects(overlay.submit(Array.from(forged.tx)));assert.equal(await overlay.lookup(`${forged.txid}.0`),null);
  const offer={id:'mock-offer',outpoint:mint.outpoint,tokenId:mint.tokenId,tokenAmount:'1',priceSatoshis:100,sellerIdentityKey:issuerIdentityKey,sellerKeyIndex:0,network};const approval={...offer,buyerIdentityKey:buyerId};const swaps=new Journal<SwapRecord>();
  const prepared=await prepareSwap(buyer,offer,approval,0,overlay,swaps);const signature=await approveSwap(seller,prepared,approval,overlay);const receipt=await completeSwap(buyer,prepared,signature,approval,overlay,swaps);
  assert.equal(receipt.status,'overlay_admitted');await receiveSwapProceeds(seller,receipt);assert.equal((await overlay.lookup(mint.outpoint))?.spent,true);assert.equal((await overlay.lookup(`${receipt.txid}.1`))?.spent,false);
  assert.equal(Transaction.fromAtomicBEEF(receipt.transaction).outputs[0].satoshis,100);
 }finally{await server.close();await chain.close();rmSync(dir,{recursive:true,force:true});}
});
