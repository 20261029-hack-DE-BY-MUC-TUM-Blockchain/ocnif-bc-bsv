import {PrivateKey, PublicKey} from '@bsv/sdk';
export interface Config {
  overlayPort:number; overlayUrl:string; overlayDb:string;
  marketDb:string; walletDb:string; network:'main'|'test'; origins:string[];
  overlayKey:string; adminToken:string; merchantKey?:string; issuerIdentity?:string;
  chaintracksUrl:string; arcadeUrl:string; backendUrl:string; internalToken:string;
  reportSatoshis:number; paymentWindowMs:number;
}
function url(value:string,internal=false):string {
  const parsed=new URL(value);const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  if(parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.protocol!=='https:'&&!((local||internal)&&parsed.protocol==='http:')))throw new Error('Invalid service URL');
  return parsed.href.replace(/\/$/,'');
}
function integer(value:string,min:number,max:number):number {const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Invalid numeric configuration');return n;}
export function loadConfig(env:NodeJS.ProcessEnv=process.env):Config {
  const network=env.BSV_NETWORK??'main';if(network!=='main'&&network!=='test')throw new Error('Invalid BSV_NETWORK');
  const overlayKey=env.OVERLAY_PRIVATE_KEY??'';PrivateKey.fromHex(overlayKey);
  if(!/^[a-f0-9]{64}$/.test(overlayKey))throw new Error('OVERLAY_PRIVATE_KEY is required');
  const adminToken=env.INTERNAL_TOKEN??'';if(adminToken.length<32)throw new Error('INTERNAL_TOKEN is required');
  const merchantKey=env.BSV_MERCHANT_PRIVATE_KEY||undefined;if(merchantKey)PrivateKey.fromHex(merchantKey);
  const issuerIdentity=env.BSV_ISSUER_IDENTITY_KEY||undefined;if(issuerIdentity)PublicKey.fromString(issuerIdentity);
  return {overlayPort:integer(env.OVERLAY_PORT??'8097',1,65535),
    overlayUrl:url(env.OVERLAY_PUBLIC_URL??'http://127.0.0.1:8097'),overlayDb:env.OVERLAY_DB??'/data/overlay.sqlite',
    marketDb:env.BSV_MARKET_DB??'/data/market.sqlite',walletDb:env.BSV_MERCHANT_DB??'/data/merchant.sqlite',network,
    origins:(env.ALLOWED_ORIGINS??'http://localhost:3000').split(',').map(x=>new URL(x.trim()).origin),
    overlayKey,adminToken,merchantKey,issuerIdentity,chaintracksUrl:url(env.CHAINTRACKS_URL??'https://arcade-v2-us-1.bsvblockchain.tech'),
    arcadeUrl:url(env.ARCADE_URL??'https://arcade-v2-us-1.bsvblockchain.tech'),backendUrl:url(env.BACKEND_URL??'http://127.0.0.1:8080',true),internalToken:adminToken,
    reportSatoshis:integer(env.BSV_REPORT_SATOSHIS??'100',1,100000000),paymentWindowMs:integer(env.BSV_PAYMENT_WINDOW_MS??'300000',30000,600000)};
}
