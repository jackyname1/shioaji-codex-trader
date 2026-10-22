import type {Plan} from './models.js';

/** Model reply admission and an activated strategy's lifetime are separate clocks. */
export function planActive(plan:Plan|null|undefined,at:Date|string|number):plan is Plan {
  if(!plan)return false;
  const time=at instanceof Date?at.getTime():typeof at==='number'?at:Date.parse(at);
  const created=Date.parse(plan.created_at);
  return Number.isFinite(time)&&Number.isFinite(created)&&created<=time
    &&(plan.lifecycle==='UNTIL_REPLACED'||Date.parse(plan.analysis.expires_at)>time);
}
/** Legacy timed records retain their original deadline; never rewrite historical outcomes. */
export const planDeadline=(plan:Plan):string|null=>plan.lifecycle==='UNTIL_REPLACED'?null:plan.analysis.expires_at;
