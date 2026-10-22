import type {Plan,Settings,Snapshot} from './models.js';
import {planActive} from './plan-lifecycle.js';

export type StrategyValidationCode='REPLY_TIMEZONE_REQUIRED'|'REPLY_TIME_INVALID'|'REPLY_EXPIRED'|'REPLY_DEADLINE_EXCEEDED'
  |'SNAPSHOT_MISMATCH'|'SNAPSHOT_STALE'|'SNAPSHOT_IN_FUTURE'|'STRATEGY_SCHEMA_INVALID'|'STRATEGY_SEMANTIC_INVALID'|'STRATEGY_CLOCK_INVALID';
/** Safe, stable diagnostics: never include model text, local paths or credentials. */
export class StrategyValidationError extends Error {
  constructor(readonly code:StrategyValidationCode,message:string) {
    super('策略驗證 ['+code+']：'+message);this.name='StrategyValidationError';
  }
}
/** Admission is anchored to the supplied snapshot, never to a model's arithmetic or response latency. */
export function decisionDeadline(snapshot:Pick<Snapshot,'asof'>,settings:Settings):string {
  const asof=Date.parse(snapshot.asof),minutes=settings.plan_max_minutes;
  if(!Number.isFinite(asof)||!Number.isFinite(minutes)||minutes<=0)
    throw new StrategyValidationError('STRATEGY_CLOCK_INVALID','決策時鐘或本機期限設定不合法');
  return new Date(asof+minutes*60000).toISOString();
}
export function validateDecisionTime(expiry:string,snapshot:Snapshot,now:Date,settings:Settings):void {
  const time=now.getTime(),asof=Date.parse(snapshot.asof);
  if(!Number.isFinite(time)||!Number.isFinite(asof))
    throw new StrategyValidationError('STRATEGY_CLOCK_INVALID','決策時鐘不合法');
  if(asof>time)throw new StrategyValidationError('SNAPSHOT_IN_FUTURE','快照晚於決策時間');
  if(time-asof>(settings.codex_timeout_seconds+30)*1000)
    throw new StrategyValidationError('SNAPSHOT_STALE','Codex 決策資料已過期');
  const deadline=Date.parse(decisionDeadline(snapshot,settings)),expires=Date.parse(expiry);
  if(!Number.isFinite(expires))throw new StrategyValidationError('REPLY_TIME_INVALID','回覆期限格式不合法');
  if(expires<=time)throw new StrategyValidationError('REPLY_EXPIRED','模型回覆已過啟用期限；本輪不採用');
  if(expires>deadline)throw new StrategyValidationError('REPLY_DEADLINE_EXCEEDED','回覆期限超過本機快照的啟用窗口');
}
/** Only a rejected proposal may fall back. Data, persistence and broker failures still fail closed.
 * No retry of rejected output: a later scheduled attempt uses a new snapshot and the existing call budget.
 */
export function mayRetainStrategy(plan:Plan|undefined,error:unknown,now:Date):boolean {
  const invalidOutput=error instanceof Error&&'diagnostic' in error
    &&(error as Error&{diagnostic?:{kind?:string;code?:string}}).diagnostic?.kind==='OTHER'
    &&(error as Error&{diagnostic?:{kind?:string;code?:string}}).diagnostic?.code==='INVALID_OUTPUT';
  return planActive(plan,now)&&(error instanceof StrategyValidationError||invalidOutput);
}
