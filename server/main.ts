import {loadConfig} from './config.ts';
import {startOverlay} from './overlay.ts';
try {
 const server=await startOverlay(loadConfig());
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void server.close().finally(()=>process.exit(0));});
 console.info(JSON.stringify({event:'bsv_service_ready'}));
}catch{console.error(JSON.stringify({event:'bsv_service_start_failed'}));process.exitCode=1;}
