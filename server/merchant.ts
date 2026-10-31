import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import makeKnex from 'knex';
import {Services,StorageKnex,Wallet,WalletStorageManager} from '@bsv/wallet-toolbox';
import type {ChainTracker,WalletInterface} from '@bsv/sdk';
import type {Config} from './config.ts';
// Wallet Toolbox uses the SDK CJS class identities internally.
const {CachedKeyDeriver,PrivateKey}=createRequire(import.meta.url)('@bsv/sdk') as typeof import('@bsv/sdk',{with:{'resolution-mode':'require'}});
export async function openMerchant(config:Config,chainTracker:ChainTracker):Promise<{wallet:WalletInterface;close:()=>Promise<void>}|undefined>{
 if(!config.merchantKey)return undefined;
 mkdirSync(dirname(config.walletDb),{recursive:true});const db=makeKnex({client:'better-sqlite3',connection:{filename:config.walletDb},useNullAsDefault:true,pool:{min:1,max:1}});
 await db.raw('PRAGMA journal_mode = DELETE');await db.raw('PRAGMA busy_timeout = 5000');
 const key=PrivateKey.fromHex(config.merchantKey);const identity=key.toPublicKey().toString();
 const provider=new StorageKnex({chain:config.network,knex:db,commissionSatoshis:0,feeModel:{model:'sat/kb',value:100}});
 await provider.migrate('ocnif-report-merchant',identity);await provider.makeAvailable();
 const storage=new WalletStorageManager(identity,provider);await storage.makeAvailable();
 const services=new Services({...Services.createDefaultOptions(config.network),chainTracker:chainTracker as never,arcadeUrl:config.arcadeUrl});storage.setServices(services);
 const wallet=new Wallet({chain:config.network,keyDeriver:new CachedKeyDeriver(key),storage,services});
 return {wallet,async close(){await wallet.destroy();await db.destroy();}};
}
