import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import Database from 'better-sqlite3';
import express,{type Application,type Request,type Response} from 'express';
import {validatePayment,send402} from '@bsv/402-pay/server';
import {ProtoWallet,Transaction,Utils,type WalletInterface} from '@bsv/sdk';
import {canonical,reportDigest,reportCommitment,type PublishedReport} from '../src/report-contract.ts';
import {PASS_PROTOCOL,ACCESS_PROTOCOL,OFFER_PROTOCOL,type ReportQuote,type PassRegistration,type AccessChallenge} from '../src/market.ts';
import {readToken,tokenOwner} from '../src/token.ts';
import type {TokenOverlay} from '../src/swap.ts';
import type {Config} from './config.ts';
import {boundedJson} from '../src/http.ts';
const ID=/^[A-Za-z0-9_-]{1,100}$/;
function record(x:unknown):Record<string,any>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('invalid_object');return x as Record<string,any>;}
function exact(x:unknown,keys:string[]):Record<string,any>{const r=record(x);if(Object.keys(r).length!==keys.length||keys.some(k=>!(k in r)))throw Error('unknown_or_missing_field');return r;}
function signature(x:unknown):number[]{if(!Array.isArray(x)||x.length<8||x.length>80||!x.every(n=>Number.isInteger(n)&&n>=0&&n<=255))throw Error('invalid_signature');return x;}
function validId(x:unknown):string{if(typeof x!=='string'||!ID.test(x))throw Error('invalid_id');return x;}
export async function backendReport(config:Config,id:string):Promise<PublishedReport|null>{
 const response=await fetch(`${config.backendUrl}/internal/reports/${validId(id)}`,{headers:{Authorization:`Bearer ${config.internalToken}`},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status===404)return null;if(!response.ok)throw Error('report_backend_unavailable');
 const report=exact(await boundedJson(response),['id','title','content','cards','created_at','published_at','source']);
 if(report?.id!==id||report.source!=='user-approved'||!report.published_at||typeof report.title!=='string'||typeof report.content!=='string'||!Array.isArray(report.cards))throw Error('report_not_published');return report as PublishedReport;
}
export async function attachMarket(app:Application,config:Config,overlay:TokenOverlay,merchant?:WalletInterface,fetchReport:(id:string)=>Promise<PublishedReport|null>=(id)=>backendReport(config,id)){
 mkdirSync(dirname(config.marketDb),{recursive:true});const db=new Database(config.marketDb);db.pragma('journal_mode = DELETE');db.pragma('busy_timeout = 5000');
 db.exec('CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS payment_claims(txid TEXT PRIMARY KEY, quote_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS passes(token_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY, report_id TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)');
 const merchantIdentity=merchant?(await merchant.getPublicKey({identityKey:true})).publicKey:undefined;
 const verifier=new ProtoWallet('anyone');
 const router=express.Router();router.use(express.json({limit:1_450_000}));
 router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();});
 router.get('/config',(_req,res)=>res.json({network:config.network==='main'?'mainnet':'testnet',overlayUrl:config.overlayUrl,merchantIdentityKey:merchantIdentity??null,issuerIdentityKey:config.issuerIdentity??null,paymentStatus:merchant?'ready':'setup_required',passStatus:config.issuerIdentity?'ready':'setup_required'}));
 router.get('/reports/:id/pass-intent',async(req,res)=>{
  if(!config.issuerIdentity){res.status(503).json({status:'setup_required',required:'issuer_identity'});return;}
  const report=await fetchReport(validId(req.params.id));if(!report){res.status(404).json({error:'published_report_not_found'});return;}
  res.json({id:randomUUID(),reportId:report.id,reportDigest:reportDigest(report),issuerIdentityKey:config.issuerIdentity,network:config.network==='main'?'mainnet':'testnet',keyIndex:0});
 });
 router.get('/reports/:id/quote',async(req,res)=>{
  const report=await fetchReport(validId(req.params.id));if(!report){res.status(404).json({error:'published_report_not_found'});return;}
  if(!merchantIdentity){res.status(503).json({status:'setup_required',required:'merchant_wallet'});return;}
  const quote:ReportQuote={id:randomUUID(),reportId:report.id,title:report.title,recipientIdentityKey:merchantIdentity,satoshis:config.reportSatoshis,network:config.network==='main'?'mainnet':'testnet',expiresAt:Date.now()+config.paymentWindowMs,reportDigest:reportDigest(report)};
  if((db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE expires>=?').get(Date.now()) as {n:number}).n>=10000){res.status(503).json({error:'quote_capacity'});return;}
  db.prepare('DELETE FROM quotes WHERE expires < ?').run(Date.now());db.prepare('INSERT INTO quotes VALUES(?,?,?)').run(quote.id,JSON.stringify(quote),quote.expiresAt);res.json(quote);
 });
 async function pay(req:Request,res:Response){
  if(!merchant||!merchantIdentity){res.status(503).json({status:'setup_required',required:'merchant_wallet'});return;}
  const row=db.prepare('SELECT body FROM quotes WHERE id=? AND expires>=?').get(validId(req.params.id),Date.now()) as {body:string}|undefined;
  if(!row){res.status(404).json({error:'quote_not_found_or_expired'});return;}const quote=JSON.parse(row.body) as ReportQuote;
  const report=await fetchReport(quote.reportId);if(!report||reportDigest(report)!==quote.reportDigest){res.status(409).json({error:'published_report_changed'});return;}
  const payment=req.method==='POST'?exact(exact(req.body,['payment']).payment,['x-bsv-beef','x-bsv-sender','x-bsv-nonce','x-bsv-time','x-bsv-vout']):req.headers;
  if(!payment['x-bsv-beef']){send402(res,merchantIdentity,quote.satoshis);return;}
  if(typeof payment['x-bsv-beef']!=='string'||payment['x-bsv-beef'].length>1_400_000)throw Error('invalid_payment');
  let tx:Transaction;try{tx=Transaction.fromAtomicBEEF(Utils.toArray(payment['x-bsv-beef'],'base64'));}catch{throw Error('invalid_payment');}
  if(!tx.outputs.some(x=>x.satoshis===0&&x.lockingScript.toHex()===reportCommitment(quote.reportDigest))){res.status(400).json({error:'payment_report_mismatch'});return;}
  const paid=await validatePayment({path:req.path,headers:payment},merchant,quote.satoshis,config.paymentWindowMs,{claim(txid,expires){return db.prepare('INSERT OR IGNORE INTO payment_claims VALUES(?,?,?)').run(txid,quote.id,expires).changes===1;}});
  if(!paid||!paid.accepted){res.status(402).set({'x-bsv-sats':String(quote.satoshis),'x-bsv-server':merchantIdentity}).json({error:'payment_invalid_or_replayed'});return;}
  res.json({report,payment:paid,confirmed:false});
 }
 router.get('/quotes/:id/pay',pay);router.post('/quotes/:id/pay',pay);
 router.post('/passes',async(req,res)=>{
  if(!config.issuerIdentity){res.status(503).json({status:'setup_required',required:'issuer_identity'});return;}
  const body=exact(req.body,['registration','signature']);const registration=exact(body.registration,['intent','tokenId','outpoint']) as unknown as PassRegistration;const intent=exact(registration.intent,['id','reportId','reportDigest','issuerIdentityKey','network','keyIndex']);
  validId(intent.id);validId(intent.reportId);if(intent.issuerIdentityKey!==config.issuerIdentity||intent.network!==(config.network==='main'?'mainnet':'testnet')||registration.tokenId!==registration.outpoint.replace('.','_'))throw Error('pass_issuer_mismatch');
  const report=await fetchReport(intent.reportId);if(!report||reportDigest(report)!==intent.reportDigest){res.status(404).json({error:'published_report_not_found'});return;}
  await verifier.verifySignature({protocolID:[...PASS_PROTOCOL],keyID:intent.id,counterparty:config.issuerIdentity,data:Utils.toArray(canonical(registration),'utf8'),signature:signature(body.signature)});
  const admitted=await overlay.lookup(registration.outpoint);const output=admitted?.transaction.outputs[admitted.outputIndex];const token=output&&readToken(output.lockingScript,registration.outpoint);
  if(!admitted||admitted.spent||token?.id!==registration.tokenId||token.amount!=='1'||token.ownerPkh!==tokenOwner(config.issuerIdentity,intent.keyIndex)||!admitted.transaction.outputs.some(x=>x.satoshis===0&&x.lockingScript.toHex()===reportCommitment(intent.reportDigest)))throw Error('pass_mint_not_admitted');
  db.prepare('INSERT INTO passes VALUES(?,?,?)').run(registration.tokenId,report.id,intent.reportDigest);res.status(201).json({tokenId:registration.tokenId,reportId:report.id,reportDigest:intent.reportDigest,status:'registered'});
 });
 async function owned(c:Pick<AccessChallenge,'reportId'|'reportDigest'|'outpoint'|'holderIdentityKey'|'keyIndex'>){
  const admitted=await overlay.lookup(c.outpoint);const output=admitted?.transaction.outputs[admitted.outputIndex];const token=output&&readToken(output.lockingScript,c.outpoint);
  if(!admitted||admitted.spent||!token||token.amount!=='1'||token.ownerPkh!==tokenOwner(c.holderIdentityKey,c.keyIndex))throw Error('pass_not_owned');
  if(!db.prepare('SELECT token_id FROM passes WHERE token_id=? AND report_id=? AND digest=?').get(token.id,c.reportId,c.reportDigest))throw Error('pass_not_registered');
 }
 router.post('/offers',async(req,res)=>{
  const body=exact(req.body,['listing','signature']);const listing=exact(body.listing,['reportId','reportDigest','offer']);
  const offer=exact(listing.offer,['id','outpoint','tokenId','tokenAmount','priceSatoshis','sellerIdentityKey','sellerKeyIndex','network']);
  validId(offer.id);validId(listing.reportId);
  if(offer.tokenAmount!=='1'||offer.network!==(config.network==='main'?'mainnet':'testnet')||!Number.isSafeInteger(offer.priceSatoshis)||offer.priceSatoshis<1||offer.priceSatoshis>100000000)throw Error('invalid_offer');
  const admitted=await overlay.lookup(offer.outpoint);const token=admitted&&readToken(admitted.transaction.outputs[admitted.outputIndex].lockingScript,offer.outpoint);if(token?.id!==offer.tokenId)throw Error('offer_token_mismatch');
  await owned({reportId:listing.reportId,reportDigest:listing.reportDigest,outpoint:offer.outpoint,holderIdentityKey:offer.sellerIdentityKey,keyIndex:offer.sellerKeyIndex});
  await verifier.verifySignature({protocolID:[...OFFER_PROTOCOL],keyID:offer.id,counterparty:offer.sellerIdentityKey,data:Utils.toArray(canonical(listing),'utf8'),signature:signature(body.signature)});
  db.prepare('INSERT INTO offers VALUES(?,?,?,?)').run(offer.id,listing.reportId,JSON.stringify(listing),Date.now());res.status(201).json({id:offer.id,status:'listed',requiresBothWallets:true});
 });
 router.get('/reports/:id/offers',async(req,res)=>{
  const rows=db.prepare('SELECT body FROM offers WHERE report_id=? ORDER BY created DESC LIMIT 10').all(validId(req.params.id)) as {body:string}[];
  const results=await Promise.all(rows.map(async row=>{const listing=JSON.parse(row.body);try{await owned({reportId:listing.reportId,reportDigest:listing.reportDigest,outpoint:listing.offer.outpoint,holderIdentityKey:listing.offer.sellerIdentityKey,keyIndex:listing.offer.sellerKeyIndex});return listing;}catch{return null;}}));res.json({offers:results.filter(Boolean),requiresBothWallets:true});
 });
 router.post('/reports/:id/token-challenge',async(req,res)=>{
  const body=exact(req.body,['outpoint','holderIdentityKey','keyIndex']);const report=await fetchReport(validId(req.params.id));if(!report){res.status(404).json({error:'published_report_not_found'});return;}
  const challenge:AccessChallenge={id:randomUUID(),reportId:report.id,reportDigest:reportDigest(report),outpoint:body.outpoint,holderIdentityKey:body.holderIdentityKey,keyIndex:body.keyIndex,expiresAt:Date.now()+config.paymentWindowMs};
  await owned(challenge);if((db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE expires>=?').get(Date.now()) as {n:number}).n>=10000){res.status(503).json({error:'challenge_capacity'});return;}db.prepare('DELETE FROM challenges WHERE expires < ?').run(Date.now());db.prepare('INSERT INTO challenges(id,body,expires) VALUES(?,?,?)').run(challenge.id,JSON.stringify(challenge),challenge.expiresAt);res.json(challenge);
 });
 router.post('/reports/:id/token-access',async(req,res)=>{
  const body=exact(req.body,['challengeId','signature']);const row=db.prepare('SELECT body FROM challenges WHERE id=? AND used=0 AND expires>=?').get(validId(body.challengeId),Date.now()) as {body:string}|undefined;
  if(!row){res.status(409).json({error:'challenge_expired_or_used'});return;}const c=JSON.parse(row.body) as AccessChallenge;if(c.reportId!==validId(req.params.id))throw Error('challenge_report_mismatch');
  await verifier.verifySignature({protocolID:[...ACCESS_PROTOCOL],keyID:c.id,counterparty:c.holderIdentityKey,data:Utils.toArray(canonical(c),'utf8'),signature:signature(body.signature)});await owned(c);
  const report=await fetchReport(c.reportId);if(!report||reportDigest(report)!==c.reportDigest)throw Error('report_changed');
  if(db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0').run(c.id).changes!==1){res.status(409).json({error:'challenge_already_used'});return;}
  res.json({report,access:{status:'overlay_owner_verified',outpoint:c.outpoint},confirmed:false});
 });
 router.use((_error:unknown,_req:Request,res:Response,_next:unknown)=>res.status(400).json({error:'request_rejected'}));app.use('/v1',router);
 return {close:()=>db.close()};
}
