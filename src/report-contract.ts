import {Hash, LockingScript, Utils} from '@bsv/sdk';
export interface PublishedReport {id:string;title:string;content:string;cards:unknown[];created_at:string|number;published_at:string|number;source:'user-approved'}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function reportDigest(report:PublishedReport):string {return Utils.toHex(Hash.sha256(Utils.toArray(canonical(report),'utf8')));}
export function reportCommitment(digest:string):string {
  if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('invalid_report_digest');
  return LockingScript.fromASM(`OP_FALSE OP_RETURN ${Utils.toHex(Utils.toArray('ocnif-report','utf8'))} ${digest}`).toHex();
}
