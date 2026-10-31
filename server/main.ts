import {loadConfig} from './config.ts';
import {startOverlay} from './overlay.ts';
import {openMerchant} from './merchant.ts';
import {attachMarket} from './market.ts';
import {HttpTokenOverlay} from '../src/overlay.ts';
try {
 const config=loadConfig();let merchant:Awaited<ReturnType<typeof openMerchant>>;let market:Awaited<ReturnType<typeof attachMarket>>;
 const server=await startOverlay(config,undefined,async(app,tracker)=>{
  merchant=await openMerchant(config,tracker);market=await attachMarket(app,config,new HttpTokenOverlay(config.overlayInternalUrl),merchant?.wallet);
 });
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void server.close().then(async()=>{market.close();await merchant?.close();}).finally(()=>process.exit(0));});
 console.info(JSON.stringify({event:'bsv_service_ready',merchantConfigured:!!merchant,issuerConfigured:!!config.issuerIdentity}));
}catch{console.error(JSON.stringify({event:'bsv_service_start_failed'}));process.exit(1);}
