import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine } from './engine.js';
import { PaperBroker, type SimulatedFill } from '../broker/paper.js';
import { HistoricalMarket, validateDataset, validDay, type HistoryDataset } from './backtest-data.js';
import { SettingsSchema, addDays, d, equity, marketValue, twClock, twDay, type Analysis, type Settings, type Snapshot } from './models.js';
import { demoAnalysis } from './strategy.js';
import { experienceContext } from './experience.js';

export const BacktestRequestSchema = z.strictObject({
  start:z.string().refine(validDay),end:z.string().refine(validDay),
  initial_cash:z.string().regex(/^\d+(?:\.\d+)?$/).refine(v=>d(v).gte(100)&&d(v).lte('1000000000')).default('100000'),
  source:z.enum(['sample','csv','shioaji']).default('sample'),strategy:z.enum(['demo','codex']).default('demo'),
  whole_lots:z.boolean().default(false),decision_interval_minutes:z.number().int().min(10).max(240).default(60),
  max_codex_calls:z.number().int().min(1).max(2000).default(100),
  participation:z.string().regex(/^0\.\d+$/).refine(v=>d(v).gt(0)&&d(v).lte('.1')).default('0.01'),
}).refine(x=>x.start<=x.end&&Date.parse(x.end)-Date.parse(x.start)<=366*86400000,'日期區間須為 1–367 天')
  .refine(x=>x.strategy!=='demo'||x.source==='sample','示範策略只能使用虛構資料；歷史資料須選 Codex');
export type BacktestRequest=z.infer<typeof BacktestRequestSchema>;
export interface BacktestProgress {running:boolean;phase:string;day:string;points:number;total_points:number;codex_calls:number;message:string}
export interface BacktestReport {
  version:'0.3.0';id:string;created_at:string;status:'COMPLETED'|'CANCELLED'|'FAILED';request:BacktestRequest;
  source:string;synthetic:boolean;frequency:string;model:string;prompt_version:string;settings:Record<string,unknown>;
  metrics:{initial_cash:string;final_cash:string;settlement_credits:string;stock_value:string;final_equity:string;
    net_pnl:string;return_pct:string;realized_pnl:string;unrealized_pnl:string;fees:string;taxes:string;
    max_drawdown_pct:string;filled_orders:number;fill_count:number;winning_sell_fill_pct:string|null;
    codex_calls:number;decision_successes:number;decision_failures:number;risk_refusals:number};
  daily_equity:{day:string;cash:string;settlement_credits:string;equity:string}[];
  fills:SimulatedFill[];orders:import('./models.js').Order[];reviews:import('./experience.js').ExperienceReview[];
  logs:string[];limitations:string[];
}
export type BacktestAnalyst=(snapshot:Snapshot,signal:AbortSignal)=>Promise<Analysis>;
export async function runBacktest(input:unknown,datasetInput:HistoryDataset,base:Settings,
  analyze:BacktestAnalyst|undefined,signal:AbortSignal,onProgress:(p:BacktestProgress)=>void=()=>undefined):Promise<BacktestReport> {
  const request=BacktestRequestSchema.parse(input),dataset=validateDataset(datasetInput);
  if(request.strategy==='demo'&&!dataset.synthetic)throw new Error('回測示範策略不能套用真實歷史資料');
  if(request.strategy==='codex'&&(!analyze||!base.codex_enabled))throw new Error('回測 Codex 需先啟用並在本機登入');
  if(!dataset.synthetic&&request.end>=twDay(new Date()))throw new Error('回測真實資料的結束日必須早於今天，避免未完成行情');
  const settings=SettingsSchema.parse({...base,mode:'demo',auto_execute:true,whole_lots:request.whole_lots,
    demo_cash:request.initial_cash,decision_interval_minutes:request.decision_interval_minutes,official_facts_enabled:false});
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,dataset.synthetic),id=randomUUID();
  if(dataset.calendar)store.saveSessions(dataset.calendar);
  store.set('experience_scope','backtest:'+id);store.saveSettings(settings);
  // The imported dataset establishes available sessions. Never borrow live account state or future experience.
  const days=new Set(dataset.points.map(p=>twDay(new Date(p.at))));
  const sessions=[];
  for(let day=twDay(new Date(dataset.points[0]!.at));day<=addDays(request.end,1);day=addDays(day,1))
    if(!store.session(day))sessions.push({day,open:days.has(day),source:dataset.source,verified_at:new Date().toISOString()});
  if(sessions.length)store.saveSessions(sessions);
  const market=new HistoricalMarket(dataset,request.participation),broker=new PaperBroker(store,market,settings,calendar,true),engine=new Engine(store,broker,settings,calendar);
  const times=[...new Set(market.points.filter(p=>{const day=twDay(new Date(p.at));return day>=request.start&&day<=request.end;}).map(p=>p.at))].sort();
  if(!times.length){store.close();throw new Error('回測日期區間沒有可用行情');}
  const limitations=[...dataset.limitations,
    '使用與即時交易相同的風控、智慧單、不可當沖及部分成交引擎；所有委託只在獨立記憶體模擬帳戶執行',
    '決策只看到截至虛擬時間已提供的價格與此前已完成日 K；不讀取今日新聞、營收或既有實盤經驗',
    '缺少零股歷史五檔時，以股票 K 線收盤價前後一個 tick 估價；深度採 volume_shares × participation，並非實際零股撮合',
    '委託最早在提交後下一筆價格事件成交；不使用下一根 K 線高低點替當前委託判斷成交；ROD 收盤撤銷',
    'K 線收盤價逐筆重播，不能還原 K 線內先觸停損或停利的順序；無法驗證撮合排隊與真實滑價',
    '歷史商品漲跌停以此前收盤 ±10% 及跳動單位估算；未還原處置、注意、停牌、除權息、分割及退市狀態',
    '買進金額及費用立即從可用資金預留；賣出淨額於已知行事曆 T+2 轉為可用，不能提早買進',
    '期末庫存按最後可取得價格估值，未強制賣光，也未扣除未來賣出費用；缺漏行情可能使估值過期',
    ...(request.strategy==='codex'?['Codex 歷史重播仍可能受到模型預訓練中已知歷史事件影響，不等於嚴格樣本外測試；呼叫會消耗本機登入方案額度／費用']:[])];
  let status:BacktestReport['status']='COMPLETED',calls=0,successes=0,intradaySuccesses=0,failures=0,currentDay='',lastSlot='',peak=d(request.initial_cash),drawdown=d(0),steps=0;
  const daily:BacktestReport['daily_equity']=[];
  const completedDays=new Set<string>();
  const progress=(phase:string,message:string):void=>onProgress({running:true,phase,day:currentDay,points:steps,total_points:times.length,codex_calls:calls,message});
  const decision=async(now:Date,review=false):Promise<void>=>{
    if(signal.aborted)return;
    if(request.strategy==='codex'&&calls>=request.max_codex_calls){engine.entryBlocked=true;
      if(!limitations.includes('已達 Codex 呼叫上限，後續不新增決策，既有保護持續'))limitations.push('已達 Codex 呼叫上限，後續不新增決策，既有保護持續');return;}
    try {
      progress(review?'REVIEW':'ANALYSIS',`${review?'檢討':'分析'} ${now.toISOString()}`);
      const snapshot=await engine.snapshot(now,review);snapshot.synthetic=dataset.synthetic;
      snapshot.hard_limits={...snapshot.hard_limits,historical_replay:true,virtual_time:now.toISOString()};
      snapshot.data_limitations=limitations;
      let analysis:Analysis;
      if(request.strategy==='codex'){calls++;analysis=await analyze!(snapshot,signal);}
      else {analysis=demoAnalysis(snapshot,settings,now);
        if(settings.whole_lots&&!review&&analysis.decisions[0])analysis.decisions[0].shares=1000;
        if(review){const c=experienceContext(store,settings,now.toISOString());analysis.stance='HOLD_ONLY';
          analysis.summary=`示範檢討（非 Codex）：最近 ${c.sample_count} 筆經驗，已實現損益=${c.realized_pnl??'未賣出'}。小額零股需評估最低手續費；未以此證明策略有效。`;}}
      if(signal.aborted)return;
      await engine.activate(analysis,snapshot,now);successes++;if(!review)intradaySuccesses++;
    }catch{
      if(signal.aborted)return;failures++;engine.entryBlocked=true;
      engine.log('ANALYSIS_FAIL',`${twDay(now)} ${twClock(now)} 歷史決策失敗，停止新買進，既有保護持續`);
      for(const o of store.orders(true))if(o.purpose==='ENTRY')await engine.cancel(o.local_id,now);
    }
  };
  const finishDay=async(day:string):Promise<void>=>{
    if(completedDays.has(day))return;completedDays.add(day);
    const now=new Date(day+'T14:00:00+08:00');
    for(const o of store.orders(true))await engine.cancel(o.local_id,now);
    const account=await engine.refreshAccount(now);
    daily.push({day,cash:account.cash,settlement_credits:account.settlement_credits,equity:equity(account).toFixed(2)});
    if(!signal.aborted)await decision(now,true);
  };
  try {
    await engine.start(new Date(times[0]!));
    for(const time of times){
      if(signal.aborted){status='CANCELLED';break;}
      const now=new Date(time),day=twDay(now);
      if(currentDay&&day!==currentDay)await finishDay(currentDay);
      if(signal.aborted){status='CANCELLED';break;}
      currentDay=day;steps++;await engine.tick(now);
      if(calendar.inSession(now)){
        const clock=twClock(now),minutes=Number(clock.slice(0,2))*60+Number(clock.slice(3));
        const slot=day+':'+Math.floor((minutes-550)/request.decision_interval_minutes);
        if(slot!==lastSlot){lastSlot=slot;await decision(now);if(!signal.aborted)await engine.tick(now);}
      }
      const value=equity(engine.account!);
      if(value.gt(peak))peak=value;const loss=peak.minus(value).div(peak);
      if(loss.gt(drawdown))drawdown=loss;
      if(steps%25===0){progress('REPLAY','重播行情、執行智慧單與核對模擬成交');await yieldToEvents();}
    }
    if(currentDay)await finishDay(currentDay);
    if(signal.aborted)status='CANCELLED';
    if(request.strategy==='codex'&&!intradaySuccesses&&!signal.aborted){status='FAILED';limitations.push('沒有任何有效 Codex 盤中決策；本次損益不能用來評估 Codex 策略');}
    const now=new Date((currentDay||request.start)+'T14:00:00+08:00'),account=await engine.refreshAccount(now),fills=broker.fills();
    const final=equity(account),realized=fills.reduce((sum,f)=>sum.plus(f.realized_pnl??'0'),d(0)),unrealized=marketValue(account).minus(broker.remainingCost());
    const sales=fills.filter(f=>f.action==='SELL'),refusals=store.db.prepare("SELECT COUNT(*) AS n FROM experiences WHERE json_extract(value,'$.kind')='RISK_REFUSAL'").get() as {n:number};
    return {version:'0.3.0',id,created_at:new Date().toISOString(),status,request,source:dataset.source,synthetic:dataset.synthetic,frequency:dataset.frequency,
      model:request.strategy==='codex'?(base.codex_model||'本機 Codex 預設模型'):'示範策略（未呼叫 Codex）',prompt_version:'trading-experience-v1',
      settings:Object.fromEntries(['min_cash_fraction','max_order_fraction','max_symbol_fraction','max_exposure_fraction','max_daily_buy_fraction',
        'max_daily_buy_orders','daily_loss_fraction','fee_rate','minimum_fee','sell_tax_rate','plan_max_minutes','experience_enabled'].map(k=>[k,settings[k as keyof Settings]])),
      metrics:{initial_cash:request.initial_cash,final_cash:account.cash,settlement_credits:account.settlement_credits,stock_value:marketValue(account).toFixed(2),
        final_equity:final.toFixed(2),net_pnl:final.minus(request.initial_cash).toFixed(2),return_pct:final.div(request.initial_cash).minus(1).times(100).toFixed(4),
        realized_pnl:realized.toFixed(2),unrealized_pnl:unrealized.toFixed(2),fees:fills.reduce((sum,f)=>sum.plus(f.fee),d(0)).toFixed(2),
        taxes:fills.reduce((sum,f)=>sum.plus(f.tax),d(0)).toFixed(2),max_drawdown_pct:drawdown.times(100).toFixed(4),
        filled_orders:new Set(fills.map(f=>f.order_id)).size,fill_count:fills.length,
        winning_sell_fill_pct:sales.length?d(sales.filter(f=>d(f.realized_pnl!).gt(0)).length).div(sales.length).times(100).toFixed(2):null,
        codex_calls:calls,decision_successes:successes,decision_failures:failures,risk_refusals:refusals.n},
      daily_equity:daily,fills,orders:store.orders(),reviews:store.reviews('backtest:'+id,now.toISOString(),2000),logs:store.logs(2000),limitations};
  }finally{await engine.close();store.close();}
}
export function formatBacktestReport(r:BacktestReport):string {
  const m=r.metrics;
  return [`歷史模擬 ${r.status} | ${r.request.start} 至 ${r.request.end}`,`資料：${r.source}`,`策略：${r.model} | 允許整股=${r.request.whole_lots}`,
    `起始資金=${m.initial_cash} 期末淨值=${m.final_equity} 現金=${m.final_cash} 待收交割=${m.settlement_credits} 股票市值=${m.stock_value}`,
    `淨損益=${m.net_pnl} 報酬=${m.return_pct}% 已實現=${m.realized_pnl} 未實現=${m.unrealized_pnl}`,
    `手續費=${m.fees} 交易稅=${m.taxes} 最大回撤=${m.max_drawdown_pct}%`,
    `成交委託=${m.filled_orders} 成交明細=${m.fill_count} 獲利賣出成交比例=${m.winning_sell_fill_pct??'無賣出'}%`,
    `Codex 呼叫=${m.codex_calls} 有效分析／檢討=${m.decision_successes} 分析失敗=${m.decision_failures} 風控拒絕=${m.risk_refusals}`,
    '',...r.daily_equity.map(x=>`${x.day} 淨值=${x.equity} 現金=${x.cash} 待收=${x.settlement_credits}`),
    '',...r.limitations].join('\n');
}
const csvValue=(x:unknown):string=>'"'+String(x??'').replace(/"/g,'""')+'"';
export function fillsCsv(r:BacktestReport):string {
  const fields=['at','symbol','action','lot','purpose','shares','price','amount','fee','tax','realized_pnl'] as const;
  return '\uFEFF'+fields.join(',')+'\r\n'+r.fills.map(f=>fields.map(k=>csvValue(f[k])).join(',')).join('\r\n');
}
