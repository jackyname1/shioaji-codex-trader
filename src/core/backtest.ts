import {buildIdentity} from './build-identity.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine } from './engine.js';
import { PaperBroker, type SimulatedFill } from '../broker/paper.js';
import { HistoricalMarket, validateDataset, validDay, type HistoryDataset } from './backtest-data.js';
import { SettingsSchema, addDays, ageSeconds,d, equity, marketValue, twClock, twDay, type Analysis, type Settings, type Snapshot } from './models.js';
import { programAnalysis } from './program-strategy.js';
import { ReplayClock,validReplaySpeed } from './replay-clock.js';
import type { WatchState } from './watchlist.js';
import { demoAnalysis } from './strategy.js';
import { experienceContext } from './experience.js';
import { nextMonitorTime, strategySlots } from './schedule.js';
import type { WatchChange } from './watchlist.js';
import { codexIssue,codexFailureKind,shouldHaltCodex,diagnoseCodexFailure } from './codex.js';
import type {CodexFailureDetail} from './codex-failure.js';
import type { AnalystEvent } from './codex.js';
import type { ExecutionRequest,ExecutionAdvice } from './execution.js';
import {replayCapitalSettings} from './capital.js';
import {EntryDiagnosticTracker,type EntryDiagnostics} from './entry-diagnostics.js';
import {entryDiagnosticText} from './entry-diagnostics-text.js';
import {tradeStatistics,exitStatistics} from './performance.js';
import {backtestDiagnostics,backtestExport,type BacktestDiagnostics} from './backtest-export.js';
import {planActive,planDeadline} from './plan-lifecycle.js';

export const BacktestRequestSchema = z.strictObject({
  start:z.string().refine(validDay),end:z.string().refine(validDay),
  initial_cash:z.string().regex(/^\d+(?:\.\d+)?$/).refine(v=>d(v).gte(100)&&d(v).lte('1000000000')).default('100000'),
  source:z.enum(['sample','csv','shioaji']).default('shioaji'),strategy:z.enum(['demo','codex','rules']).default('codex'),
  capital_profile:z.enum(['active','balanced','custom']).default('custom'),
  entry_cadence:z.enum(['market','scheduled']).default('scheduled'),
  start_time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  end_time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('23:59'),
  symbols:z.array(z.string().regex(/^[1-9]\d{3}$/)).max(100).refine(v=>new Set(v).size===v.length,'股票代碼不可重複').default([]),
  playback_speed:z.number().refine(validReplaySpeed,'加速限 1–60 倍；0 為直達模式').default(0),
  whole_lots:z.boolean().default(false),decision_interval_minutes:z.number().int().min(10).max(360).default(180),
  strategy_schedule:SettingsSchema.shape.strategy_schedule.default('interval'),strategy_times:SettingsSchema.shape.strategy_times,
  monitor_interval_seconds:SettingsSchema.shape.monitor_interval_seconds,watch_refresh_minutes:SettingsSchema.shape.watch_refresh_minutes,
  comparison_intervals:z.array(z.number().int().min(10).max(360)).max(5).refine(v=>new Set(v).size===v.length,'比較間隔不可重複').default([]),
  // Omitted legacy/API requests keep their daily schedule; desktop presets explicitly pass five sessions.
  strategy_every_sessions:z.number().int().min(1).max(20).default(1),
  max_codex_calls:z.number().int().min(1).max(2000).default(20),
  postmarket_review_enabled:z.boolean().default(false),
  execution_sizing:z.enum(['codex','deterministic']).optional(),
  execution_slippage_bps:z.number().int().min(0).max(100).default(0),
  fill_assumption:z.enum(['legacy','optimistic','neutral','conservative']).default('legacy'),
  research:z.strictObject({portfolio:z.boolean().default(false),entry_quality:z.boolean().default(false),exit_mode:z.enum(['baseline','fixed','atr_trail']).default('baseline'),drawdown:z.enum(['0.03','0.04','0.05']).default('0.04'),cooldown:z.number().int().min(1).max(20).default(2),prompt_compaction:z.boolean().default(false)}).optional(),
  participation:z.string().regex(/^0\.\d+$/).refine(v=>d(v).gt(0)&&d(v).lte('.1')).default('0.01'),
}).refine(x=>x.start<=x.end&&Date.parse(x.end)-Date.parse(x.start)<=366*86400000,'日期區間須為 1–367 天')
  .refine(x=>x.start!==x.end||x.start_time<=x.end_time,'開始時間不能晚於結束時間')
  .refine(x=>x.strategy!=='demo'||x.source==='sample','示範策略只能使用虛構資料；歷史資料須選 Codex')
  .transform(x=>x.strategy==='codex'?{...x,monitor_interval_seconds:300,watch_refresh_minutes:5}:x)
  .refine(x=>!x.comparison_intervals.length||x.strategy_schedule==='interval','自動比較請使用間隔模式');
export type BacktestRequest=z.infer<typeof BacktestRequestSchema>;
export function replayBounds(request:BacktestRequest,now=new Date()):{start:string;end:string}{
  return {start:new Date(request.start+'T'+request.start_time+':00+08:00').toISOString(),
    end:new Date(Math.min(Date.parse(request.end+'T'+request.end_time+':59.999+08:00'),request.source==='sample'?Infinity:now.getTime())).toISOString()};
}
export interface ReplayFrame {at:string;account:import('./models.js').Account;watch:WatchState;plan:import('./models.js').Plan|null;
  protections:import('./models.js').Protection[];entry_tracks?:import('./models.js').EntryTrack[];quotes:import('./models.js').Quote[];fills:SimulatedFill[];net_pnl:string;
  decisions?:{symbol:string;state:string;reason:string;source:string}[];next_event_at?:string;last_monitor_at?:string;
  execution_queue?:{symbol:string;action:string;state:string;trigger:string}[]}
export interface BacktestProgress {running:boolean;phase:string;day:string;points:number;total_points:number;codex_calls:number;message:string;run?:number;total_runs?:number;
  at?:string;next_event_at?:string;last_error?:string;effective_settings?:Record<string,unknown>}
export interface ReplayActivity {at:string;stage:string;message:string;symbols?:string[];screening?:Analysis['screening'];order_id?:string;trigger?:string;state?:string;details?:Record<string,unknown>}
export interface BacktestQuality {sessions:number;covered_sessions:number;calendar_verified:boolean;missing_sessions:string[];warmup:Record<string,number>;
  insufficient_symbols:string[];last_marks:Record<string,string>;strategy_slots:number;successful_strategies:number;skipped_strategies:number;
  universe_mode?:'DAILY_HISTORICAL'|'FIXED';universe_sessions?:number;execution_model?:'APPROXIMATE';
  halted_at?:string;halt_reason?:'CODEX_BUDGET'|'CODEX_QUOTA'|'CODEX_RATE_LIMIT'|'CODEX_NETWORK'|'CODEX_AUTH'|'CODEX_ACCESS'|'CODEX_MODEL'|'CODEX_RUNTIME'|'CODEX_TIMEOUT';processed_sessions?:number}
export interface BacktestReport {
  version:'0.2.5'|'0.2.3'|'0.2.2'|'0.2.1'|'0.2.0'|'0.1.0'|'0.4.0'|'0.5.0';entry_diagnostics?:EntryDiagnostics;final_frame?:ReplayFrame;dataset_id?:string;timeline?:{at:string;equity:string;cash:string}[];id:string;created_at:string;asof:string;status:'COMPLETED'|'PARTIAL'|'CANCELLED'|'FAILED';request:BacktestRequest;
  build?:ReturnType<typeof buildIdentity>;source:string;synthetic:boolean;frequency:string;model:string;prompt_version:string;settings:Record<string,unknown>;
  metrics:{initial_cash:string;final_cash:string;settlement_credits:string;stock_value:string;final_equity:string;
    net_pnl:string;return_pct:string;realized_pnl:string;unrealized_pnl:string;fees:string;taxes:string;max_drawdown_pct:string;
    filled_orders:number;fill_count:number;winning_sell_fill_pct:string|null;codex_calls:number;decision_successes:number;decision_failures:number;
    risk_refusals:number;watch_scans:number;watch_adds:number;watch_removes:number;monitor_checks:number;
    execution_requests?:number;execution_confirmations?:number;execution_failures?:number;smart_monitor_checks?:number;
    gross_pnl?:string;total_costs?:string;cost_drag_pct?:string;sell_orders?:number;
    average_exposure_pct?:string;max_exposure_pct?:string;exposure_samples?:number;
    trades?:ReturnType<typeof tradeStatistics>;exits?:ReturnType<typeof exitStatistics>;daily_loss_breach_days?:string[];
    average_close_exposure_pct?:string;daily_sharpe?:string|null;skipped_idle_checks?:number};
  quality:BacktestQuality;positions:import('./models.js').Position[];
  strategy_log:{at:string;review:boolean;stance:string;expires_at:string;lifecycle?:import('./models.js').Plan['lifecycle'];summary:string;selected:string[]}[];watch_changes:WatchChange[];
  workflow?:ReplayActivity[];failures?:{at:string;review:boolean;stage:string;issue:string;diagnostic?:CodexFailureDetail}[];normalization?:HistoryDataset['normalization'];
  analyst_events?:AnalystEvent[];
  diagnostics?:BacktestDiagnostics;
  daily_equity:{day:string;cash:string;settlement_credits:string;equity:string;asof:string;complete:boolean;exposure_pct?:string}[];
  fills:SimulatedFill[];orders:import('./models.js').Order[];reviews:import('./experience.js').ExperienceReview[];logs:string[];limitations:string[];
}
export type BacktestAnalyst=(snapshot:Snapshot,signal:AbortSignal)=>Promise<Analysis>;
export type BacktestSizer=(request:ExecutionRequest,signal:AbortSignal)=>Promise<ExecutionAdvice>;
interface ReplayEvent {at:string;market:boolean;check:boolean;watch:boolean;decision?:boolean;close:boolean}
/** Count all open sessions from the anchor, including an open day missing market bars. */
export function replayAnalysisDays(days:string[],calendar:TradingCalendar,every=1,anchor=days[0]??''):Set<string> {
  if(!Number.isInteger(every)||every<1||every>20)throw new Error('回測分析間隔須為 1–20 個交易日');
  const last=[...days].sort().at(-1),selected=new Set<string>();if(!last||!anchor)return selected;
  let sessions=0;for(let day=anchor;day<=last;day=addDays(day,1))if(calendar.isOpen(day)){
    if(sessions%every===0)selected.add(day);sessions++;
  }
  return selected;
}
export function replayEvents(marketTimes:string[],days:string[],settings:Settings,calendar:TradingCalendar,every=1,anchor=days[0]??''):ReplayEvent[] {
  const analysisDays=replayAnalysisDays(days,calendar,every,anchor);
  const events=new Map<string,ReplayEvent>();
  const add=(at:string,flags:Partial<ReplayEvent>):void=>{const iso=new Date(at).toISOString();
    const old=events.get(iso)??{at:iso,market:false,check:false,watch:false,close:false};Object.assign(old,flags);events.set(iso,old);};
  const legacyCheck=(at:string):void=>{
    const t=nextMonitorTime(new Date(at),settings.monitor_interval_seconds);
    for(let n=0;n<2;n++){const time=new Date(t.getTime()+n*settings.monitor_interval_seconds*1000);
      if(calendar.inSession(time,'COMMON'))add(time.toISOString(),{check:true});}
  };
  // Legacy offline fixtures retain their short cadence; Codex always uses the complete five-minute grid.
  // Ordinary proposals use the schedule; stateful rebound/protection checks also use market events.
  for(const at of marketTimes){add(at,{market:true});if(settings.monitor_interval_seconds<300)legacyCheck(at);}
  for(const day of days){if(!calendar.isOpen(day))continue;
    for(const slot of analysisDays.has(day)?strategySlots(day,settings,calendar):[]){add(slot.at,{decision:slot.review});if(!slot.review&&settings.monitor_interval_seconds<300)legacyCheck(slot.at);}
    const opening=day<'2026-12-07'?550:540;
    for(let second=opening*60;settings.monitor_interval_seconds>=300&&second<810*60;second+=settings.monitor_interval_seconds){
      const at=new Date(Date.parse(day+'T00:00:00+08:00')+second*1000).toISOString();
      add(at,{check:true});
    }
    for(let m=opening;m<810;m+=settings.watch_refresh_minutes){
      const at=`${day}T${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00+08:00`;
      add(at,{watch:true});if(settings.monitor_interval_seconds<300)legacyCheck(at);}
    add(day+'T13:30:00+08:00',{close:true});}
  return [...events.values()].sort((a,b)=>a.at.localeCompare(b.at));
}
export async function runBacktest(input:unknown,datasetInput:HistoryDataset,base:Settings,analyze:BacktestAnalyst|undefined,
  signal:AbortSignal,onProgress:(p:BacktestProgress)=>void=()=>undefined,clock?:ReplayClock,onFrame?:(frame:ReplayFrame)=>void,
  onActivity?:(activity:ReplayActivity)=>void,size?:BacktestSizer,rulesAnalyst:typeof programAnalysis=programAnalysis):Promise<BacktestReport> {
  const request=BacktestRequestSchema.parse(input),dataset=validateDataset(datasetInput);
  if(request.strategy==='demo'&&!dataset.synthetic)throw new Error('回測示範策略不能套用真實歷史資料');
  if(request.strategy==='codex'&&(!analyze||!base.codex_enabled))throw new Error('回測 Codex 需先啟用並在本機登入');
  if(!dataset.synthetic&&request.end>twDay(new Date()))throw new Error('回測結束日不能晚於現在');
  const bounds=replayBounds(request);
  if(bounds.start>bounds.end)throw new Error('回測開始時間不能晚於現在');
  const settings=SettingsSchema.parse({...replayCapitalSettings(base,request.capital_profile),...(request.research?{portfolio_risk_enabled:request.research.portfolio,entry_quality_enabled:request.research.entry_quality,research_exit_mode:request.research.exit_mode,portfolio_drawdown_fraction:request.research.drawdown,portfolio_cooldown_sessions:request.research.cooldown,prompt_compaction:request.research.prompt_compaction}:{}),mode:'demo',auto_execute:true,whole_lots:request.whole_lots,demo_cash:request.initial_cash,
    decision_interval_minutes:request.decision_interval_minutes,strategy_schedule:request.strategy_schedule,strategy_times:request.strategy_times,
    monitor_interval_seconds:request.monitor_interval_seconds,watch_refresh_minutes:request.watch_refresh_minutes,official_facts_enabled:false,
    replay_every_sessions:request.strategy_every_sessions,postmarket_review_enabled:request.postmarket_review_enabled,
    execution_sizing:request.execution_sizing??base.execution_sizing,
    codex_enabled:request.strategy==='codex'&&base.codex_enabled});
  const reportSettings=Object.fromEntries(['min_cash_fraction','max_order_fraction','order_budget_basis','target_exposure_fraction','min_entry_reward_risk','max_trade_risk_fraction','max_symbol_fraction','max_exposure_fraction','max_daily_buy_fraction',
    'max_daily_buy_orders','daily_loss_fraction','fee_rate','minimum_fee','sell_tax_rate','plan_max_minutes','experience_enabled',
    'trade_direction','replay_every_sessions','watch_max_symbols','watch_min_amount','watch_remove_after_scans','entry_strategy_mode','entry_policy','execution_sizing','adaptive_protection','dynamic_allocation',
    'risk_slippage_fraction','overnight_gap_fraction','max_gap_risk_fraction','min_net_profit_twd','entry_tracking_minutes','portfolio_risk_enabled','portfolio_components','portfolio_drawdown_fraction','portfolio_cooldown_sessions','portfolio_loss_streak','entry_quality_enabled','research_exit_mode','max_portfolio_stop_fraction','prompt_compaction'].map(k=>[k,settings[k as keyof Settings]]));
  if(dataset.frequency==='DAILY'&&request.strategy_schedule==='fixed')throw new Error('回測日 K 無法還原固定時刻的盤中行情；請使用分鐘 K，或選間隔排程作開盤時點的近似測試');
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,dataset.synthetic),id=randomUUID();
  if(dataset.calendar)store.saveSessions(dataset.calendar);store.set('experience_scope','backtest:'+id);store.saveSettings(settings);
  store.set('historical_real_data',!dataset.synthetic);
  store.set('historical_replay',true);
  store.set('replay_capital_profile',request.capital_profile);
  const allHistory=[...(dataset.daily_history??[]),...dataset.points],observedDays=new Set(allHistory.map(p=>twDay(new Date(p.at)))),sessions=[];
  const firstAt=[dataset.points[0]!.at,...(dataset.daily_history?.length?[dataset.daily_history[0]!.at]:[])].sort()[0]!;
  for(let day=twDay(new Date(firstAt));day<=addDays(request.end,1);day=addDays(day,1))
    if(!store.session(day))sessions.push({day,open:observedDays.has(day),source:dataset.source,verified_at:new Date().toISOString()});
  if(sessions.length)store.saveSessions(sessions);
  const market=new HistoricalMarket(dataset,request.participation,d(request.execution_slippage_bps).div(10000).toFixed(),request.fill_assumption),broker=new PaperBroker(store,market,settings,calendar,true),engine=new Engine(store,broker,settings,calendar);
  const displayQuotes=new Map<string,ReplayFrame['quotes'][number]>();
  const rememberQuotes=(now:Date):void=>{
    for(const q of engine.quotes.values())if(Date.parse(q.trade_at)<=now.getTime()){
      const key=`${q.symbol}:${q.odd}`,previous=displayQuotes.get(key);
      if(!previous||Date.parse(q.trade_at)>Date.parse(previous.trade_at))displayQuotes.set(key,structuredClone(q));
    }
  };
  const replayQuotes=(now:Date):ReplayFrame['quotes']=>{rememberQuotes(now);return [...displayQuotes.values()];};
  const marketTimes=[...new Set(market.points.filter(p=>{const day=twDay(new Date(p.at));return p.at>=bounds.start&&p.at<=bounds.end;}).map(p=>p.at))].sort();
  if(!marketTimes.length){store.close();throw new Error('回測日期區間沒有可用行情');}
  const coveredDays=[...new Set(marketTimes.map(at=>twDay(new Date(at))))],expectedDays:string[]=[];
  for(let day=request.start;day<=request.end;day=addDays(day,1))if(calendar.isOpen(day))expectedDays.push(day);
  const warmup:Record<string,number>={};for(const symbol of new Set(allHistory.map(p=>p.symbol)))
    warmup[symbol]=(await market.history(symbol,new Date(request.start+'T08:00:00+08:00'))).length;
  if(!Object.values(warmup).some(n=>n>=20)){store.close();throw new Error('回測暖機不足：至少一檔需要開始日前 20 個已完成交易日，建議提供 60 日');}
  const calendarVerified=expectedDays.every(day=>store.session(day)?.source.startsWith('https://www.twse.com.tw/'));
  const quality:BacktestQuality={sessions:expectedDays.length,covered_sessions:expectedDays.filter(d=>coveredDays.includes(d)).length,calendar_verified:calendarVerified,
    missing_sessions:expectedDays.filter(d=>!coveredDays.includes(d)),warmup,insufficient_symbols:Object.keys(warmup).filter(s=>warmup[s]!<20),
    last_marks:{},strategy_slots:0,successful_strategies:0,skipped_strategies:0};
  quality.universe_mode=dataset.daily_universe?'DAILY_HISTORICAL':'FIXED';
  quality.universe_sessions=Object.keys(dataset.daily_universe??{}).length;quality.execution_model='APPROXIMATE';
  const anchor=expectedDays.find(day=>strategySlots(day,settings,calendar).some(slot=>!slot.review&&Date.parse(slot.at)>=Date.parse(bounds.start)&&Date.parse(slot.at)<=Date.parse(bounds.end)))??request.start;
  const events=replayEvents(marketTimes,coveredDays,settings,calendar,request.strategy_every_sessions,anchor).filter(e=>e.at>=bounds.start&&e.at<=bounds.end);
  const limitations=[...dataset.limitations,
    `策略每 ${request.strategy_every_sessions} 個交易日分析；休市不計、缺行情的已知交易日仍計入間隔。成功啟用後持續有效，直到新策略成功接替；間隔日持續核對行情、條件與持倉保護。額外盤後檢討只在分析日執行，且不替換盤中策略`,
    ...(dataset.normalization?.duplicates?[`已整理 ${dataset.normalization.duplicates} 筆重複股票／時間；${dataset.normalization.revisions} 筆行情採用 Shioaji 同批最後修訂，成交量未重複加總`]:[]),
    '使用與即時交易相同的排程、觀測增刪、進場規則、風控、智慧單及部分成交引擎；委託只在獨立記憶體帳戶執行',
    '決策只看到截至虛擬時間已提供的價格與已完成日 K；盤中排除當日，盤後有收盤資料才納入當日；不讀取今日新聞、營收或既有實盤經驗',
    `觀測股每五分鐘更新；一般進場${request.entry_cadence==='market'?'也逐筆檢查可用價格事件':'按原排程檢查'}；反彈買進與持倉保護逐筆檢查可用分鐘收盤價，不插值或猜測同根高低價順序`,
    '歷史智慧退場由程式按當前可賣股數提案，不額外呼叫 Codex 確認股數；仍核對新鮮行情、風控、零股不可當沖與未完成委託，不保證立即成交；即時工作台原股數確認流程不變',
    '缺少零股歷史五檔時，以股票 K 線收盤價前後一個 tick 估價；深度為 volume_shares × participation，並非實際零股撮合',
    '委託最早在提交後下一筆價格事件成交；不使用下一根 K 線高低點判斷當前成交；ROD 收盤撤銷',
    'K 線不能還原其內先觸停損或停利的順序，也無法驗證撮合排隊與真實滑價；日 K 無法測試盤中策略效果',
    '歷史漲跌停以前收盤 ±10% 估算；未還原處置、注意、停牌、除權息、分割及退市狀態',
    '買進金額及費用立即預留；賣出淨額於已知行事曆 T+2 轉為可用，不能提早買進',
    '期末庫存按最後可取得價格估值，未強制賣光或扣除未來賣出費用；請核對最後估值日期',
    ...(!calendarVerified?['本區間沒有完整官方行事曆，使用資料中的行情日推定；無法辨識缺資料是否休市，T+2 僅為保守近似']:[]),
    ...(request.strategy==='codex'?['Codex 可能在預訓練中知道歷史事件，不等於嚴格樣本外測試；呼叫會消耗本機登入方案額度／費用',
      '回測等待 Codex 時凍結虛擬行情；實盤等待期間價格仍會變動，故無法由回測驗證分析延遲的成交影響']:[])];
  let status:BacktestReport['status']='COMPLETED',calls=0,successes=0,failures=0,currentDay='',lastTime=events[0]!.at,peak=d(request.initial_cash),drawdown=d(0),steps=0,checks=0,lastMonitor='',nextEvent='',lastError='';
  let sizeRequests=0,sizeConfirmations=0,sizeFailures=0,smartChecks=0;
  let idleSettled=false,skippedIdle=0;
  const entryDiagnostics=new EntryDiagnosticTracker();
  const timeline:NonNullable<BacktestReport['timeline']>=[];
  let exposureSum=d(0),maxExposure=d(0),exposureSamples=0;
  const daily:BacktestReport['daily_equity']=[],strategyLog:BacktestReport['strategy_log']=[],completedDays=new Set<string>();
  const workflow:ReplayActivity[]=[],failureLog:NonNullable<BacktestReport['failures']>=[];
  const activity=(at:string,stage:string,message:string,details:Partial<ReplayActivity>={}):void=>{
    const item={...details,at,stage,message};workflow.push(item);onActivity?.(item);};
  const progress=(phase:string,message:string):void=>onProgress({running:true,phase,day:currentDay,at:lastTime,next_event_at:nextEvent,last_error:lastError,points:steps,total_points:events.length,codex_calls:calls,message,effective_settings:reportSettings});
  const frame=(now:Date):ReplayFrame=>({at:now.toISOString(),account:structuredClone(engine.account!),watch:structuredClone(engine.watch),plan:engine.plan?structuredClone(engine.plan):null,
    protections:store.protections(),entry_tracks:store.entryTracks(),quotes:replayQuotes(now),fills:broker.fills(-100),net_pnl:equity(engine.account!).minus(request.initial_cash).toFixed(2),
    decisions:[...engine.decisionStates].map(([symbol,state])=>({symbol,...state})),next_event_at:nextEvent,last_monitor_at:lastMonitor,
    execution_queue:[...engine.pendingExecutions.values()].map(t=>({symbol:t.order.symbol,action:t.order.action,state:t.state,trigger:t.trigger}))});
  const cancelEntries=async(now:Date):Promise<void>=>{for(const o of store.orders(true))if(o.purpose==='ENTRY')await engine.cancel(o.local_id,now);};
  const haltCodex=async(error:unknown,now:Date):Promise<void>=>{
    const kind=codexFailureKind(error);if(!shouldHaltCodex(error))return;
    quality.halted_at=now.toISOString();quality.halt_reason=('CODEX_'+kind) as BacktestQuality['halt_reason'];
    status='PARTIAL';engine.entryBlocked=true;await cancelEntries(now);
    for(const id of [...engine.pendingExecutions.keys()])engine.finishExecution(id,'SIZE_FAILED','Codex 無法確認；本次未送單，回測已停止',now);
    const note=`${codexIssue(error)}；已停止本次回測，保留截至此刻的部分結果；其餘排程／比較不再重試，也不跳過數量確認。恢復後需重新執行測試`;
    limitations.push(note);activity(now.toISOString(),'HALTED',note);
  };
  const haltBudget=async(now:Date):Promise<void>=>{
    quality.halted_at=now.toISOString();quality.halt_reason='CODEX_BUDGET';
    status=quality.successful_strategies?'PARTIAL':'FAILED';engine.entryBlocked=true;await cancelEntries(now);
    for(const id of [...engine.pendingExecutions.keys()])engine.finishExecution(id,'SIZE_FAILED','已達設定的 Codex 次數上限，未送單，回測停止',now);
    lastError='已達設定的 Codex 次數上限；回測停止於此刻，不繼續模擬剩餘期間';
    limitations.push(lastError,'呼叫上限包含選股、數量確認與檢討；未獲數量確認的觸發不會送單');
    activity(now.toISOString(),'HALTED',lastError);progress('PARTIAL',lastError);
  };
  const decision=async(now:Date,review=false):Promise<void>=>{
    if(signal.aborted)return;if(!review)quality.strategy_slots++;
    if(request.strategy==='codex'&&calls>=request.max_codex_calls){
      if(!review)quality.skipped_strategies++;
      await haltBudget(now);return;}
    let stage='SNAPSHOT';
    try{progress('SNAPSHOT',`${twClock(now)} 建立當時帳戶、行情與已完成日 K 快照`);
      activity(now.toISOString(),'SNAPSHOT','建立當時帳戶、行情、觀測股與已完成日 K 快照');
      const snapshot=await engine.snapshot(now,review);snapshot.synthetic=dataset.synthetic;
      snapshot.hard_limits={...snapshot.hard_limits,historical_replay:true,replay_analysis_every_sessions:request.strategy_every_sessions,virtual_time:now.toISOString()};snapshot.data_limitations=[...new Set([...snapshot.data_limitations,...limitations])];
      if(snapshot.observation)snapshot.observation.next_strategy_at=events.find(e=>e.decision===false&&e.at>now.toISOString())?.at??null;
      let analysis:Analysis;
      stage=review?'REVIEW':'ANALYSIS';
      if(request.strategy==='codex'){calls++;progress(stage,`${twClock(now)} 等待 Codex ${review?'盤後檢討':'選股與設定條件'}完成；虛擬時間保持不動`);
        activity(now.toISOString(),stage,`Codex ${review?'盤後檢討':'選股與條件分析'}開始；等待完整結果後才推進時間`);analysis=await analyze!(snapshot,signal);}
      else if(request.strategy==='rules'){analysis=rulesAnalyst(snapshot,settings);}
      else{analysis=demoAnalysis(snapshot,settings,now);
        if(settings.whole_lots&&!review&&analysis.decisions[0])analysis.decisions[0].shares=1000;
        if(review){const c=experienceContext(store,settings,now.toISOString());analysis.stance='HOLD_ONLY';
          analysis.summary=`流程示範檢討（非 Codex）：最近 ${c.sample_count} 筆經驗，已實現損益=${c.realized_pnl??'未賣出'}；費用與執行需納入策略，未以此證明有效。`;}}
      if(signal.aborted)return;stage='ACTIVATION';progress(stage,`${twClock(now)} 驗證選股、設定觀測門檻與進出場條件`);
      await engine.activate(analysis,snapshot,now);successes++;lastError='';if(!review)quality.successful_strategies++;
      if(!review)entryDiagnostics.strategy(analysis,snapshot.features,snapshot.instruments??{},now);
      strategyLog.push({at:now.toISOString(),review,stance:analysis.stance,expires_at:analysis.expires_at,
        ...(!review?{lifecycle:engine.plan!.lifecycle}:{}),summary:analysis.summary,selected:analysis.candidates});
      activity(now.toISOString(),review?'REVIEW':'ACTIVATION',analysis.summary,{symbols:analysis.candidates,screening:analysis.screening});
    }catch(error){if(signal.aborted)return;failures++;if(!review){engine.entryBlocked=true;await cancelEntries(now);}
      const issue=request.strategy==='codex'&&(stage==='ANALYSIS'||stage==='REVIEW')?codexIssue(error):error instanceof z.ZodError?'策略欄位格式不符，請核對結構化輸出':
        error instanceof Error&&/^(Codex|計畫|候選|策略|盤後|決策|買進|帳戶|回測)/.test(error.message)?error.message:'歷史快照或策略驗證未完成';
      lastError=`${twDay(now)} ${twClock(now)} · ${stage} · ${issue}`;failureLog.push({at:now.toISOString(),review,stage,issue,
        ...(request.strategy==='codex'&&(stage==='ANALYSIS'||stage==='REVIEW')?{diagnostic:diagnoseCodexFailure(error)}:{})});
      activity(now.toISOString(),'FAILED',lastError);engine.log('ANALYSIS_FAIL',lastError+'；既有保護條件保留，委託仍需數量確認');
      if(request.strategy==='codex'&&(stage==='ANALYSIS'||stage==='REVIEW'))await haltCodex(error,now);}
  };
  const executions=async(now:Date):Promise<void>=>{
    for(;;){if(signal.aborted||quality.halt_reason)return;const requestId=engine.nextExecutionId();if(!requestId)return;
      let input:ExecutionRequest|undefined;
      try{
        input=await engine.executionRequest(requestId,now);if(!input)continue;
        if(calls>=request.max_codex_calls){
          engine.finishExecution(requestId,'SIZE_FAILED','已達 Codex 呼叫上限，本次未送單',now);
          await haltBudget(now);return;
        }
        if(!size)throw new Error('Codex 數量確認器未提供，禁止跳過確認送單');
        calls++;sizeRequests++;progress('SIZING',`${twClock(now)} ${input.symbol} 觸發，等待 Codex 確認股數；虛擬時間保持不動`);
        activity(now.toISOString(),'SIZING',`${input.symbol} ${input.action}：${input.trigger}；可用現金 ${input.account.available_cash}，重新確認數量`,{symbols:[input.symbol]});
        onFrame?.(frame(now));const advice=await size(input,signal);if(signal.aborted)return;
        progress('SIZE_CONFIRM',`${twClock(now)} 核對 Codex 數量、最新條件與風控`);
        const sent=await engine.confirmExecution(requestId,advice,now);if(sent)sizeConfirmations++;
        activity(now.toISOString(),'SIZE_CONFIRM',`${input.symbol} ${advice.action} ${advice.shares} 股：${advice.reason}；${sent?'已通過核對並送單':engine.decisionStates.get(input.symbol)?.reason??'本次未送單'}`,{symbols:[input.symbol]});
      }catch(error){if(signal.aborted)return;sizeFailures++;failures++;
        const issue=error instanceof Error&&error.message.startsWith('Codex 數量確認器')?error.message:codexIssue(error);
        engine.finishExecution(requestId,'SIZE_FAILED',issue+'；未送單',now);
        lastError=`${twDay(now)} ${twClock(now)} · SIZING · ${issue}`;failureLog.push({at:now.toISOString(),review:false,stage:'SIZING',issue,diagnostic:diagnoseCodexFailure(error)});
        activity(now.toISOString(),'FAILED',lastError,input?{symbols:[input.symbol]}:{});
        await haltCodex(error,now);
      }
    }
  };
  const finishDay=async(day:string,partialAt?:Date):Promise<void>=>{if(completedDays.has(day))return;completedDays.add(day);
    const now=partialAt??new Date(day+'T13:30:00+08:00');for(const o of store.orders(true))await engine.cancel(o.local_id,now);
    const account=await engine.refreshAccount(now);daily.push({day,cash:account.cash,settlement_credits:account.settlement_credits,equity:equity(account).toFixed(2),asof:now.toISOString(),complete:!partialAt,
      exposure_pct:equity(account).gt(0)?marketValue(account).div(equity(account)).times(100).toFixed(4):'0'});
    activity(now.toISOString(),'CLOSE',`${partialAt?'區間結束':'收盤'}：撤銷未完成委託並核對模擬現金、庫存與交割款`);};
  const scheduleExpiry=(from:number):void=>{
    if(!engine.plan)return;const deadline=planDeadline(engine.plan);if(!deadline)return;
    const at=nextMonitorTime(new Date(deadline),settings.monitor_interval_seconds).toISOString();
    if(at<=events[from]!.at||at>bounds.end||!calendar.inSession(new Date(at),'COMMON'))return;
    let lo=from+1,hi=events.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(events[mid]!.at<at)lo=mid+1;else hi=mid;}
    if(events[lo]?.at===at)events[lo]!.check=true;
    else events.splice(lo,0,{at,market:false,check:true,watch:false,close:false});
  };
  try{calendar.setAsOf(new Date(events[0]!.at));await engine.start(new Date(events[0]!.at));
    for(let index=0;index<events.length;index++){const event=events[index]!;if(signal.aborted){status='CANCELLED';break;}
      const smartActive=request.entry_cadence==='market'||engine.plan?.analysis.screening?.entry?.signal==='MULTI'||engine.plan?.analysis.decisions.some(d=>d.entry_when==='REBOUND')
        ||store.protections().some(p=>engine.account?.positions.some(x=>x.symbol===p.symbol&&x.shares>0));
      const visibleEvent=event.check||event.watch||event.decision!==undefined||event.close||event.market&&smartActive;
      if(clock)try{await clock.before(event.at,signal,visibleEvent);}catch{if(signal.aborted){status='CANCELLED';break;}throw new Error('回測時間控制失敗');}
      const nextVisible=()=>{
        const includeMarket=request.entry_cadence==='market'||engine.plan?.analysis.screening?.entry?.signal==='MULTI'||engine.plan?.analysis.decisions.some(d=>d.entry_when==='REBOUND')
          ||store.protections().some(p=>engine.account?.positions.some(x=>x.symbol===p.symbol&&x.shares>0));
        for(let next=index+1;next<events.length;next++){const e=events[next]!;
          if(e.check||e.watch||e.decision!==undefined||e.close||e.market&&includeMarket)return e.at;}
        return '';
      };
      const now=new Date(event.at),day=twDay(now);calendar.setAsOf(now);if(currentDay&&day!==currentDay)await finishDay(currentDay);currentDay=day;lastTime=event.at;steps++;nextEvent=nextVisible();
      const freshQuote=[...engine.quotes.values()].some(q=>ageSeconds(now,q.trade_at)>=0&&ageSeconds(now,q.trade_at)<=settings.quote_max_age);
      // Offline runs may elide repeated stale-data checks. Never skip a price, decision, expiry, settlement clock, close or GUI frame.
      const expiryPending=engine.plan&&!planActive(engine.plan,now)&&store.orders(true).some(o=>o.purpose==='ENTRY');
      if(!clock&&!onFrame&&idleSettled&&!freshQuote&&!event.market&&event.decision===undefined&&!event.close&&twClock(now)!=='11:00'
        &&!expiryPending&&!engine.pendingExecutions.size){
        if(event.check){checks++;lastMonitor=event.at;entryDiagnostics.monitor(engine.decisionStates);}skippedIdle++;
        progress('REPLAY','沒有新鮮價格，重複檢查維持禁止送單');await yieldToEvents();continue;
      }
      idleSettled=!freshQuote&&!event.market;
      const revision=store.orderRevision,fillCount=broker.fillCount();
      const decisionsBefore=new Map([...engine.decisionStates].map(([symbol,state])=>[symbol,state.state+':'+state.reason]));
      progress('RECONCILE',`${twClock(now)} 處理價格事件並核對已存在的模擬委託`);
      const marketEntry=request.entry_cadence==='market'&&event.market&&!signal.aborted&&!quality.halt_reason;
      await engine.tick(now,marketEntry,event.market&&!signal.aborted&&!quality.halt_reason);
      if(event.market)smartChecks++; // Standing orders reconcile before current-price smart conditions.
      rememberQuotes(now); // Preserve the last historical mark for the UI when the trading engine expires stale quotes.
      if(event.market)for(const q of engine.quotes.values())if(q.trade_at===event.at)quality.last_marks[q.symbol]=q.trade_at;
      if(event.watch&&settings.auto_watchlist)await engine.refreshWatch(await engine.collectBundle(now),now);
      if(event.decision!==undefined){
        onFrame?.(frame(now));await decision(now,event.decision);scheduleExpiry(index);nextEvent=nextVisible();
      }
      if(event.check&&!signal.aborted&&!quality.halt_reason){checks++;lastMonitor=event.at;progress('MONITOR',`${twClock(now)} 檢查進出場條件、風控與模擬送單`);await engine.tick(now,true);}
      if((event.check||event.market)&&!signal.aborted&&!quality.halt_reason)await executions(now);
      if(event.check||marketEntry)entryDiagnostics.monitor(engine.decisionStates);
      progress('RECONCILE',`${twClock(now)} 核對送單結果、成交股數與模擬帳務`);await engine.reconcile(now,true);
      const changes=store.changedOrders(revision),changed=changes.map(c=>c.order);
      for(const change of changes.filter(c=>c.created))activity(event.at,'TRIGGER',`${change.order.symbol} ${change.order.action}：${change.order.trigger_reason??'既有策略條件觸發'}`,
        {symbols:[change.order.symbol],order_id:change.order.local_id,trigger:change.order.exit_trigger??change.order.trigger_reason,details:{order:change.order,trigger_context:change.order.trigger_context}});
      if(changed.length){activity(event.at,'MONITOR','已完成進出場條件與風控檢查');
        for(const order of changed)activity(event.at,changes.find(c=>c.order.local_id===order.local_id)!.created?'SUBMISSION':'RECONCILE',`${order.symbol} ${order.action} ${order.filled}/${order.shares} 股 · ${order.status} · 限價 ${order.limit_price}`,{symbols:[order.symbol],order_id:order.local_id,trigger:order.exit_trigger,state:order.status,details:{order}});}
      for(const fill of broker.fills(fillCount))activity(event.at,'FILL',`${fill.symbol} ${fill.action} ${fill.shares} 股 @ ${fill.price} · 手續費 ${fill.fee} · 稅 ${fill.tax}`,{symbols:[fill.symbol],order_id:fill.order_id,trigger:fill.exit_trigger,details:{fill}});
      for(const [symbol,state] of engine.decisionStates)if(decisionsBefore.get(symbol)!==state.state+':'+state.reason)
        activity(event.at,'SIGNAL_STATE',`${symbol} ${state.state}：${state.reason}`,{symbols:[symbol],state:state.state});
      for(const [symbol,state] of engine.decisionStates)if(state.state==='BLOCKED'&&decisionsBefore.get(symbol)!==state.state+':'+state.reason)
        activity(event.at,'RISK',`${symbol}：${state.reason}`,{symbols:[symbol]});
      if(event.close)await finishDay(day);
      const value=equity(engine.account!);if(value.gt(peak))peak=value;const loss=peak.minus(value).div(peak);if(loss.gt(drawdown))drawdown=loss;
      const exposure=value.gt(0)?marketValue(engine.account!).div(value).times(100):d(0);
      if(exposure.gt(maxExposure))maxExposure=exposure;
      if(event.market){exposureSum=exposureSum.plus(exposure);exposureSamples++;timeline.push({at:event.at,equity:value.toFixed(2),cash:engine.account!.cash});}
      if(visibleEvent||changed.length||broker.fillCount()>fillCount||clock?.paused||clock&&clock.speed>0){
        onFrame?.(frame(now));progress('REPLAY',`${twClock(now)} 事件已完成，${nextEvent?'準備下一觸發點 '+twClock(new Date(nextEvent)):'正在彙整結果'}`);await yieldToEvents();}
      if(quality.halt_reason)break;}
    if(currentDay)await finishDay(currentDay,signal.aborted||quality.halt_reason||twClock(new Date(lastTime))<'13:30'?new Date(lastTime):undefined);if(signal.aborted)status='CANCELLED';
    else if(!quality.successful_strategies&&(!quality.halt_reason||quality.halt_reason==='CODEX_BUDGET')){status='FAILED';limitations.push('沒有任何有效 Codex 盤中決策或程式策略；本次損益不能用來評估策略');}
    else if(failures||quality.skipped_strategies||quality.missing_sessions.length){status='PARTIAL';limitations.push('部分策略失敗、略過或交易日缺資料，這不是完整期間的成功測試');}
    const now=new Date(lastTime),account=await engine.refreshAccount(now),fills=broker.fills();
    const final=equity(account),realized=fills.reduce((sum,f)=>sum.plus(f.realized_pnl??'0'),d(0)),unrealized=marketValue(account).minus(broker.remainingCost());
    const sales=fills.filter(f=>f.action==='SELL'),refusals=store.db.prepare("SELECT COUNT(*) AS n FROM experiences WHERE json_extract(value,'$.kind')='RISK_REFUSAL'").get() as {n:number};
    const fees=fills.reduce((sum,f)=>sum.plus(f.fee),d(0)),taxes=fills.reduce((sum,f)=>sum.plus(f.tax),d(0)),costs=fees.plus(taxes);
    quality.processed_sessions=daily.length;
    if(sales.length<20)limitations.push(`僅 ${new Set(sales.map(f=>f.order_id)).size} 筆有賣出成交的委託（${sales.length} 筆賣出成交明細），小樣本不能證明策略有效；成交比例不是完整交易勝率`);
    nextEvent='';const finalFrame=frame(now);onFrame?.(finalFrame);
    const returns=daily.map((row,i)=>Number(row.equity)/Number(i?daily[i-1]!.equity:request.initial_cash)-1),mean=returns.reduce((a,b)=>a+b,0)/Math.max(1,returns.length);
    const sd=returns.length>1?Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1)):0;
    const breachDays=daily.filter(row=>store.get('daily_loss_breached_'+row.day)).map(row=>row.day);
    const report:BacktestReport={version:'0.2.5',build:buildIdentity(),entry_diagnostics:entryDiagnostics.report(store.orders()),final_frame:finalFrame,timeline,id,created_at:new Date().toISOString(),asof:now.toISOString(),status,request,source:dataset.source,synthetic:dataset.synthetic,frequency:dataset.frequency,
      model:request.strategy==='codex'?(base.codex_model||'本機 Codex 預設模型'):request.strategy==='rules'?'快速程式策略':'流程示範（未呼叫 Codex）',prompt_version:settings.prompt_compaction?'columnar-until-replaced-v4':'until-replaced-v9',
      settings:reportSettings,
      metrics:{initial_cash:request.initial_cash,final_cash:account.cash,settlement_credits:account.settlement_credits,stock_value:marketValue(account).toFixed(2),
        final_equity:final.toFixed(2),net_pnl:final.minus(request.initial_cash).toFixed(2),return_pct:final.div(request.initial_cash).minus(1).times(100).toFixed(4),
        realized_pnl:realized.toFixed(2),unrealized_pnl:unrealized.toFixed(2),fees:fees.toFixed(2),
        taxes:taxes.toFixed(2),gross_pnl:final.minus(request.initial_cash).plus(costs).toFixed(2),total_costs:costs.toFixed(2),
        cost_drag_pct:costs.div(request.initial_cash).times(100).toFixed(4),sell_orders:new Set(sales.map(f=>f.order_id)).size,max_drawdown_pct:drawdown.times(100).toFixed(4),
        filled_orders:new Set(fills.map(f=>f.order_id)).size,fill_count:fills.length,
        winning_sell_fill_pct:sales.length?d(sales.filter(f=>d(f.realized_pnl!).gt(0)).length).div(sales.length).times(100).toFixed(2):null,
        trades:tradeStatistics(fills,store.orders()),exits:exitStatistics(store.orders()),daily_loss_breach_days:breachDays,
        average_close_exposure_pct:daily.length?daily.reduce((sum,row)=>sum.plus(row.exposure_pct??0),d(0)).div(daily.length).toFixed(4):'0',
        daily_sharpe:sd>0?String(mean/sd*Math.sqrt(252)):null,
        skipped_idle_checks:skippedIdle,
        codex_calls:calls,decision_successes:successes,decision_failures:failures,risk_refusals:refusals.n,
        watch_scans:engine.watch.scans,watch_adds:engine.watch.adds,watch_removes:engine.watch.removes,monitor_checks:checks,
        execution_requests:sizeRequests,execution_confirmations:sizeConfirmations,execution_failures:sizeFailures,smart_monitor_checks:smartChecks,
        average_exposure_pct:exposureSamples?exposureSum.div(exposureSamples).toFixed(4):'0.0000',max_exposure_pct:maxExposure.toFixed(4),exposure_samples:exposureSamples},
      quality,positions:account.positions,strategy_log:strategyLog,workflow,failures:failureLog,normalization:dataset.normalization,watch_changes:engine.watch.changes,daily_equity:daily,fills,orders:store.orders(),
      reviews:store.reviews('backtest:'+id,now.toISOString(),2000),logs:store.logs(2000),limitations};
    report.diagnostics=backtestDiagnostics(report);return report;
  }finally{await engine.close();store.close();}
}
export function formatBacktestReport(r:BacktestReport):string{const m=r.metrics;
  return [`歷史模擬 ${r.status} | ${r.request.start} 至 ${r.request.end}`,`資料：${r.source}`,`策略：${r.model} | 允許整股=${r.request.whole_lots}`,
    `策略每 ${r.request.strategy_every_sessions??1} 交易日 · ${r.request.strategy_schedule==='fixed'?r.request.strategy_times.join('、'):r.request.decision_interval_minutes+' 分鐘'} / 偵測 ${r.request.monitor_interval_seconds} 秒 / 觀測 ${r.request.watch_refresh_minutes} 分鐘`,
    `起始資金=${m.initial_cash} 期末淨值=${m.final_equity} 現金=${m.final_cash} 待收交割=${m.settlement_credits} 股票市值=${m.stock_value}`,
    `淨損益=${m.net_pnl} 報酬=${m.return_pct}% 已實現=${m.realized_pnl} 未實現=${m.unrealized_pnl}`,`手續費=${m.fees} 交易稅=${m.taxes} 最大回撤=${m.max_drawdown_pct}%`,
    ...(m.gross_pnl!==undefined?[`費用前損益=${m.gross_pnl} 已支付成本=${m.total_costs} 成本占起始資金=${m.cost_drag_pct}%`]:[]),
    ...(m.average_exposure_pct!==undefined?[`持倉比例：行情時點平均=${m.average_exposure_pct}% 最高=${m.max_exposure_pct}%；配置=${r.request.capital_profile}`]:[]),
    `一般進場偵測=${r.request.entry_cadence==='market'?'逐筆可用價格事件':'原排程'}；智慧條件逐筆行情`,entryDiagnosticText(r.entry_diagnostics),
    `成交委託=${m.filled_orders} 成交明細=${m.fill_count} 獲利賣出成交比例=${m.winning_sell_fill_pct??'無賣出'}%`,
    `Codex 呼叫=${m.codex_calls} 有效分析／檢討=${m.decision_successes} 分析失敗=${m.decision_failures} 風控拒絕=${m.risk_refusals}`,
    `觀測更新=${m.watch_scans} 加入=${m.watch_adds} 移除=${m.watch_removes} 偵測=${m.monitor_checks}`,
    `資料覆蓋=${r.quality.covered_sessions}/${r.quality.sessions} 交易日；有效策略=${r.quality.successful_strategies}/${r.quality.strategy_slots}`,
    `成交模型=近似；股票池=${r.quality.universe_mode==='DAILY_HISTORICAL'?'每日歷史排行':'固定資料池'}；${r.quality.halted_at?'停止於='+r.quality.halted_at:'已處理行情截止='+r.asof}`,
    '',...r.daily_equity.map(x=>`${x.day} 淨值=${x.equity} 現金=${x.cash} 待收=${x.settlement_credits}`),'',...r.limitations].join('\n');}
export function fillsCsv(r:BacktestReport):string{return backtestExport(r,'csv').content;}

