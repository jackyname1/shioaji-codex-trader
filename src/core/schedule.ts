import { addDays, twDay, type Settings } from './models.js';
import type { TradingCalendar } from './calendar.js';

export interface StrategySlot { key:string; at:string; review:boolean }
export interface ScheduleRun { key:string; at:string; review:boolean; state:'RUNNING'|'SUCCESS'|'FAILED'; started_at:string; finished_at?:string }
export const minuteOfDay=(clock:string):number=>Number(clock.slice(0,2))*60+Number(clock.slice(3));
export const minuteClock=(minute:number):string=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
export function strategySlots(day:string,settings:Settings,calendar:TradingCalendar):StrategySlot[] {
  if(!calendar.isOpen(day))return [];
  const times=settings.strategy_schedule==='fixed'?[...settings.strategy_times]:[];
  if(settings.strategy_schedule==='interval') {
    const start=day<'2026-12-07'?550:540;
    for(let m=start;m<810;m+=settings.decision_interval_minutes)times.push(minuteClock(m));
  }
  return [...new Set(times)].sort().map(time=>({key:`${day}:${time}:strategy`,at:`${day}T${time}:00+08:00`,review:false}))
    .concat(settings.postmarket_review_enabled?[{key:`${day}:${settings.postmarket_time}:review`,at:`${day}T${settings.postmarket_time}:00+08:00`,review:true}]:[]);
}
export function dueStrategy(now:Date,settings:Settings,calendar:TradingCalendar,handled:(key:string)=>boolean):StrategySlot|undefined {
  return strategySlots(twDay(now),settings,calendar).filter(s=>{
    const age=now.getTime()-Date.parse(s.at);
    return age>=0&&age<=settings.schedule_catch_up_minutes*60000&&!handled(s.key);
  }).at(-1);
}
export function nextStrategy(now:Date,settings:Settings,calendar:TradingCalendar,handled:(key:string)=>boolean=()=>false):StrategySlot|undefined {
  for(let i=0;i<370;i++)for(const s of strategySlots(addDays(twDay(now),i),settings,calendar))
    if(Date.parse(s.at)>now.getTime()&&!handled(s.key))return s;
  return undefined;
}
// The replay skips idle timer ticks but retains every price event and the next configured check.
export function nextMonitorTime(time:Date,seconds:number,day=twDay(time)):Date {
  const anchor=Date.parse(day+'T00:00:00+08:00'),step=seconds*1000;
  return new Date(anchor+Math.ceil((time.getTime()-anchor)/step)*step);
}
