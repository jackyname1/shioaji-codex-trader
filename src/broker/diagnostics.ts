import {requestStage} from './health.js';
import type {BrokerHealth} from './health.js';

export interface EndpointDiagnostic {
  endpoint:string;stage:string;attempts:number;successes:number;failures:number;
  last_attempt_at:string|null;last_success_at:string|null;issue:string;http_status:number|null;retry_at:string|null;
}
export interface BrokerDiagnostics {
  app_version?:string;
  version:string|null;stream_connected:boolean;generation:number;trade_cache:string|null;health?:BrokerHealth;
  startup?:{phase:string;issue:string;code?:string;elapsed_ms?:number;process_exit_code?:number|null;process_signal?:string|null;ca_fallback?:boolean};
  workspace?:import('../desktop/workspace-profile.js').WorkspaceDiagnostic;
  endpoints:EndpointDiagnostic[];
}
export function mergeDiagnostics(native:BrokerDiagnostics,broker?:BrokerDiagnostics|null):BrokerDiagnostics {
  if(!broker)return native;
  const rows=new Map<string,EndpointDiagnostic>();
  for(const row of [...native.endpoints,...broker.endpoints]){
    const old=rows.get(row.endpoint);
    if(!old){rows.set(row.endpoint,row);continue;}
    const latest=(row.last_attempt_at??'')>=(old.last_attempt_at??'')?row:old;
    rows.set(row.endpoint,{...latest,attempts:old.attempts+row.attempts,successes:old.successes+row.successes,failures:old.failures+row.failures,
      last_success_at:[old.last_success_at,row.last_success_at].filter((s):s is string=>!!s).sort().at(-1)??null});
  }
  return {...native,...broker,version:broker.version??native.version,health:broker.health??native.health,endpoints:[...rows.values()]};
}
/** Metadata only: never retain a response, request body, account selector, URL query or native exception text. */
export class RequestDiagnostics {
  private rows=new Map<string,EndpointDiagnostic>();
  constructor(private readonly clock:()=>number){}
  private key(path:string):string {
    const plain=path.split('?')[0]!;
    if(/^\/data\/contracts\/[0-9A-Z]{4,8}\/info$/.test(plain))return '/data/contracts/:symbol/info';
    return /^\/(?:info|health|auth\/[a-z_]+|order\/[a-z_]+|portfolio\/[a-z_]+|stream\/[a-z_]+|data\/[a-z_]+)$/.test(plain)?plain:'/other';
  }
  private row(path:string):EndpointDiagnostic {
    const endpoint=this.key(path);let row=this.rows.get(endpoint);
    if(!row){row={endpoint,stage:requestStage(path),attempts:0,successes:0,failures:0,last_attempt_at:null,last_success_at:null,
      issue:'',http_status:null,retry_at:null};this.rows.set(endpoint,row);}return row;
  }
  attempt(path:string):void {const row=this.row(path);row.attempts++;row.last_attempt_at=new Date(this.clock()).toISOString();}
  success(path:string):void {const row=this.row(path);row.successes++;row.last_success_at=new Date(this.clock()).toISOString();row.issue='';row.http_status=null;row.retry_at=null;}
  failure(path:string,issue:string,status?:number,retryAt?:number):void {
    const row=this.row(path);row.failures++;row.issue=issue;row.http_status=status??null;row.retry_at=retryAt?new Date(retryAt).toISOString():null;
  }
  snapshot():EndpointDiagnostic[]{return structuredClone([...this.rows.values()]);}
}
