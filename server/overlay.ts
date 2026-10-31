import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import OverlayExpress from '@bsv/overlay-express';
import type {Broadcaster,ChainTracker} from '@bsv/sdk';
import {Bsv21KitTopicManager,TOPIC} from './tokenkit/topic.ts';
import {createBsv21KitLookupService,SERVICE} from './tokenkit/lookup.ts';
import {noopAdvertiser} from './tokenkit/advertiser.ts';
import type {Config} from './config.ts';
import {installEdge} from './edge.ts';
import type {Application} from 'express';
export async function startOverlay(config:Config,verification?:{chainTracker:ChainTracker;broadcaster:Broadcaster},extend?:(app:Application,tracker:ChainTracker)=>Promise<void>) {
  mkdirSync(dirname(config.overlayDb),{recursive:true});
  const server=new OverlayExpress('ocnif-tokenkit',config.overlayKey,new URL(config.overlayUrl).host,config.adminToken);
  // Upstream startup logging can include the generated admin token; use a bounded logger.
  const silent={...console,log:()=>{},info:()=>{},warn:()=>{},debug:()=>{},error:()=>{}};
  server.configureLogger(silent);installEdge(server.app,config);
  server.configurePort(config.overlayPort);server.configureNetwork(config.network);
  server.configureEdgePolicy({allowedOrigins:config.origins,jsonBodyLimitBytes:32768,binaryBodyLimitBytes:1_000_000,maxConcurrentRequests:16});
  if(verification)server.configureChainTracker(verification.chainTracker);
  else {server.configureChaintracks(config.chaintracksUrl,{apiPrefix:'/chaintracks/v2',reorgStream:false});server.configureArcade(config.arcadeUrl);server.configureArcCallbackToken(config.arcCallbackToken);}
  await server.configureKnex({client:'better-sqlite3',connection:{filename:config.overlayDb},useNullAsDefault:true,pool:{min:1,max:1}});
  await server.knex!.raw('PRAGMA journal_mode = DELETE');await server.knex!.raw('PRAGMA busy_timeout = 5000');
  server.configureEnableGASPSync(false);server.configureEnableBASMSync(false);
  server.configureEngineParams({advertiser:noopAdvertiser,maxLookupResults:500,...(verification?{broadcaster:verification.broadcaster}:{})});
  server.configureTopicManager(TOPIC,new Bsv21KitTopicManager());server.configureLookupServiceWithKnex(SERVICE,createBsv21KitLookupService);
  server.app.get('/health',(_req,res)=>res.json({status:'ok',service:'ocnif-bsv-overlay',network:config.network,topic:TOPIC,lookup:SERVICE,spv:true}));
  await server.configureEngine(false);if(extend){if(!server.chainTracker||server.chainTracker==='scripts only')throw Error('SPV tracker required');await extend(server.app,server.chainTracker);}await server.start();return server;
}
