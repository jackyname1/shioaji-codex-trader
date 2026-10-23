import {createHash} from 'node:crypto';
import type {Analysis,Snapshot} from './models.js';
import type {AnalystEvent} from './codex.js';
import type {ExecutionAdvice,ExecutionRequest} from './execution.js';
import {StrategyValidationError} from './strategy-admission.js';
/** Replay proposals, never copy historical fills/account state into a new run. The original
 * response is immutable; only a verified snapshot/request ID is rebound explicitly.
 * Missing/divergent calls fail closed instead of consulting a model or nearest future decision.
 */
export class FrozenDecisions {
 private records:{run_id:string;purpose:'STRATEGY'|'EXECUTION';asof:string;input:Snapshot|ExecutionRequest;raw:string;sha256:string;used:boolean}[]=[];
 readonly bindings:{run_id:string;purpose:string;asof:string;original_id:string;replay_id:string;response_sha256:string}[]=[];
 constructor(events:AnalystEvent[]){
  for(const e of events.filter(e=>e.stage==='SNAPSHOT'&&(e.purpose==='STRATEGY'||e.purpose==='EXECUTION'))){
   if(!e.run_id||!e.details||typeof e.details!=='object')throw new Error('REPLAY_MISSING_SNAPSHOT_IDENTITY');
   const input=structuredClone(e.details) as Snapshot|ExecutionRequest;
   if(!Number.isFinite(Date.parse(input.asof))||Date.parse(e.asof)!==Date.parse(input.asof))throw new Error('REPLAY_SNAPSHOT_TIME_MISMATCH');
   const outputs=events.filter(o=>o.run_id===e.run_id&&o.purpose===e.purpose&&o.stage==='OUTPUT');
   const raw=outputs.at(-1)?.message;
   if(!raw)throw new Error('REPLAY_MISSING_RAW_RESPONSE:'+e.run_id);
   if(this.records.some(r=>r.run_id===e.run_id))throw new Error('REPLAY_DUPLICATE_SNAPSHOT');
   this.records.push({run_id:e.run_id,purpose:e.purpose!,asof:new Date(input.asof).toISOString(),input,raw,sha256:createHash('sha256').update(raw).digest('hex'),used:false});
  }
  if(!this.records.some(r=>r.purpose==='STRATEGY'))throw new Error('REPLAY_NO_RAW_STRATEGY_RECORDS');
 }
 private reply(purpose:'STRATEGY'|'EXECUTION',input:Snapshot|ExecutionRequest):unknown {
  const matches=this.records.filter(r=>r.purpose===purpose&&Date.parse(r.asof)===Date.parse(input.asof)
   &&(purpose==='STRATEGY'?(r.input as Snapshot).review_only===(input as Snapshot).review_only
    :(r.input as ExecutionRequest).symbol===(input as ExecutionRequest).symbol&&(r.input as ExecutionRequest).action===(input as ExecutionRequest).action));
  const record=matches.find(r=>!r.used);
  if(!record)throw new Error('REPLAY_DECISION_COVERAGE_GAP:'+purpose+':'+input.asof);
  record.used=true;
  let parsed:unknown;
  try{parsed=JSON.parse(record.raw);}catch{throw new StrategyValidationError('STRATEGY_SCHEMA_INVALID','原始回覆並非有效 JSON，禁止補修');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new StrategyValidationError('STRATEGY_SCHEMA_INVALID','原始回覆不是 JSON 物件');
  const raw=parsed as Record<string,unknown>;
  const id=purpose==='STRATEGY'?'snapshot_id':'request_id',original=(record.input as unknown as Record<string,unknown>)[id];
  if(raw[id]!==original)throw new StrategyValidationError('SNAPSHOT_MISMATCH','原始回覆並未綁定原始快照，禁止重綁救回無效訊號');
  const rebound=(input as unknown as Record<string,unknown>)[id];
  this.bindings.push({run_id:record.run_id,purpose,asof:record.asof,original_id:String(original),replay_id:String(rebound),response_sha256:record.sha256});
  return {...raw,[id]:rebound}; // Never repair expires_at, prices, quantities or conditions.
 }
 analyze=async(input:Snapshot):Promise<Analysis>=>this.reply('STRATEGY',input) as Analysis;
 size=async(input:ExecutionRequest):Promise<ExecutionAdvice>=>this.reply('EXECUTION',input) as ExecutionAdvice;
 coverage(){return {records:this.records.length,used:this.records.filter(r=>r.used).length,unused:this.records.filter(r=>!r.used).map(r=>({run_id:r.run_id,purpose:r.purpose,asof:r.asof,response_sha256:r.sha256})),bindings:structuredClone(this.bindings)};}
}
