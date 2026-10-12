import {requestStage} from './health.js';
import type {BrokerHealth} from './health.js';

export interface EndpointDiagnostic {
  endpoint:string;stage:string;attempts:number;successes:number;failures:number;
  last_attempt_at:string|null;last_success_at:string|null;issue:string;http_status:number|null;retry_at:string|null;
}
export interface BrokerDiagnostics {
  version:string|null;stream_connected:boolean;generation:number;trade_cache:string|null;health?:BrokerHealth;
  endpoints:EndpointDiagnostic[];
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
