import type {Application} from 'express';
import type {Config} from './config.ts';
/** Protect custom market routes registered before OverlayExpress installs its routes. */
export function installEdge(app:Application,config:Config){
 app.disable('x-powered-by');let active=0;
 app.use((req,res,next)=>{
  res.set({'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Strict-Transport-Security':'max-age=63072000; includeSubDomains','Cross-Origin-Opener-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()'});
  const origin=req.headers.origin;
  if(origin&&!config.origins.includes(origin)){res.status(403).json({error:'origin_denied'});return;}
  if(origin)res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Expose-Headers':'x-bsv-sats,x-bsv-server','Access-Control-Allow-Headers':'Content-Type,X-Topics,x-bsv-beef,x-bsv-sender,x-bsv-nonce,x-bsv-time,x-bsv-vout','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});
  if(req.method==='OPTIONS'){res.sendStatus(204);return;}
  if(active>=16){res.status(503).json({error:'busy'});return;}active++;let done=false;const release=()=>{if(!done){done=true;active--;}};res.once('finish',release);res.once('close',release);next();
 });
}
