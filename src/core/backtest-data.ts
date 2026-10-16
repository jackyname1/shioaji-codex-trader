import { z } from 'zod';
import { csvRows } from './facts.js';
import { Store } from './store.js';
import { TradingCalendar,applyCalendarExceptions } from './calendar.js';
import { roundPrice, tickSize } from './risk.js';
import { addDays, d, twDay, twClock, SessionSchema,type SessionDay, type Account, type Bar, type Candidate, type Instrument, type Order, type Quote } from './models.js';
import type { Broker } from '../broker/types.js';

export const validDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const price = z.string().regex(/^\d+(?:\.\d+)?$/).refine(v => d(v).gt(0));
export const HistoryPointSchema = z.strictObject({
  symbol:z.string().regex(/^[1-9]\d{3}$/), at:z.string().datetime({offset:true}),
  open:price,high:price,low:price,close:price,volume_shares:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  amount_twd:z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  bid:price.optional(),ask:price.optional(),bid_shares:z.number().int().nonnegative().optional(),ask_shares:z.number().int().nonnegative().optional(),
}).refine(x => d(x.high).gte(x.open) && d(x.high).gte(x.close) && d(x.low).lte(x.open) && d(x.low).lte(x.close), 'OHLC 範圍不符')
  .refine(x => (x.bid === undefined) === (x.ask === undefined) && (!x.bid || d(x.bid).lte(x.ask!)), '買賣報價不符');
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;
export const MAX_HISTORY_POINTS=3000000;
export const DailyUniverseSchema=z.record(z.string().refine(validDay),z.strictObject({
  asof:z.string().refine(validDay),symbols:z.array(z.string().regex(/^[1-9]\d{3}$/)).min(1).max(100)
    .refine(s=>new Set(s).size===s.length,'每日股票池不可重複'),
})).refine(days=>Object.entries(days).every(([day,pool])=>pool.asof<day),'每日排行不得使用當日或未來資料');
export interface HistoryDataset {
  source:string; synthetic:boolean; frequency:'MINUTE'|'DAILY'; points:HistoryPoint[];
  names:Record<string,{name:string;exchange:'TSE'|'OTC'}>; limitations:string[];
  calendar?:SessionDay[];
  normalization?:{duplicates:number;revisions:number};
  daily_universe?:z.infer<typeof DailyUniverseSchema>;
  /** One completed daily OHLCV aggregate before each symbol's first replay membership. Never minute events. */
  daily_history?:HistoryPoint[];
  minute_starts?:Record<string,string>;
}
/** Compact only pre-entry history; all later minutes remain available, including after the symbol leaves the pool. */
export function partitionReplayHistory(input:HistoryPoint[],minuteStart:string):{points:HistoryPoint[];daily_history:HistoryPoint[]} {
  if(!validDay(minuteStart))throw new Error('回測分鐘行情起日不合法');
  const points:HistoryPoint[]=[],days=new Map<string,HistoryPoint>();
  for(const p of normalizeHistoryPoints(input).points){
    const day=twDay(new Date(p.at));if(day>=minuteStart){points.push(p);continue;}
    const key=p.symbol+':'+day,old=days.get(key),volume=d(old?.volume_shares??0).plus(p.volume_shares);
    if(volume.gt(Number.MAX_SAFE_INTEGER))throw new Error('歷史每日成交量超過可處理範圍');
    const aggregate:HistoryPoint={symbol:p.symbol,at:p.at,open:old?.open??p.open,
      high:old&&d(old.high).gt(p.high)?old.high:p.high,low:old&&d(old.low).lt(p.low)?old.low:p.low,
      close:p.close,volume_shares:volume.toNumber()};
    if(p.amount_twd!==undefined&&(!old||old.amount_twd!==undefined))aggregate.amount_twd=d(old?.amount_twd??0).plus(p.amount_twd).toFixed();
    days.set(key,aggregate);
  }
  return {points,daily_history:[...days.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.symbol.localeCompare(b.symbol))};
}
/** One closed bar per stock/instant. Provider revisions replace a bar, never add its volume twice. */
export function normalizeHistoryPoints(input:HistoryPoint[],conflicts:'reject'|'latest'='reject'):{points:HistoryPoint[];duplicates:number;revisions:number} {
  const unique=new Map<string,HistoryPoint>();let duplicates=0,revisions=0;
  for(const raw of input){const parsed=HistoryPointSchema.parse(raw),p={...parsed,at:new Date(parsed.at).toISOString()},key=p.symbol+':'+p.at;
    const previous=unique.get(key);
    if(previous){duplicates++;
      const equal=(['open','high','low','close','bid','ask','amount_twd'] as const).every(k=>previous[k]===undefined||p[k]===undefined?previous[k]===p[k]:d(previous[k]!).eq(p[k]!))
        &&(['volume_shares','bid_shares','ask_shares'] as const).every(k=>previous[k]===p[k]);
      if(!equal){if(conflicts==='reject')throw new Error(`回測股票 ${p.symbol} 在 ${new Date(p.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})} 的價格或成交量不一致，請核對 CSV 後重新匯入`);revisions++;}
    }
    unique.set(key,p);
  }
  return {points:[...unique.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.symbol.localeCompare(b.symbol)),duplicates,revisions};
}
export function validateDataset(input: HistoryDataset): HistoryDataset {
  if (!input.points.length || input.points.length+(input.daily_history?.length??0)>MAX_HISTORY_POINTS) throw new Error('回測資料必須有可重播行情，且行情與暖機日 K 合計不超過 300 萬筆；請分段測試');
  const normalized=normalizeHistoryPoints(input.points);
  const minuteStarts=input.minute_starts?z.record(z.string().regex(/^[1-9]\d{3}$/),z.string().refine(validDay)).parse(input.minute_starts):undefined;
  const dailyNormalized=input.daily_history?normalizeHistoryPoints(input.daily_history):undefined,dailyHistory=dailyNormalized?.points;
  if(dailyHistory){
    if(input.frequency!=='MINUTE')throw new Error('回測暖機日 K 只能搭配分鐘行情');
    const first=new Map<string,string>(),days=new Set<string>();
    for(const p of normalized.points){const day=twDay(new Date(p.at));if(!first.has(p.symbol))first.set(p.symbol,day);
      if(minuteStarts?.[p.symbol]&&day<minuteStarts[p.symbol]!)throw new Error('回測分鐘行情不能早於該股票的入池起日');}
    for(const p of dailyHistory){const day=twDay(new Date(p.at)),key=p.symbol+':'+day,boundary=minuteStarts?.[p.symbol]??first.get(p.symbol);
      if(!boundary||day>=boundary)throw new Error('回測暖機日 K 不得包含入池當日或未來資料');
      if(days.has(key))throw new Error('回測暖機日 K 每檔每日只能有一筆');days.add(key);}
  }
  const normalization={duplicates:(input.normalization?.duplicates??0)+normalized.duplicates+(dailyNormalized?.duplicates??0),revisions:(input.normalization?.revisions??0)+normalized.revisions};
  return {...input,points:normalized.points,normalization,...(dailyHistory?{daily_history:dailyHistory}:{}),...(minuteStarts?{minute_starts:minuteStarts}:{}),...(input.calendar?{calendar:applyCalendarExceptions(input.calendar.map(s=>SessionSchema.parse(s)))}:{}),
    ...(input.daily_universe?{daily_universe:DailyUniverseSchema.parse(input.daily_universe)}:{})};
}
export function csvDataset(text: string): HistoryDataset {
  if (Buffer.byteLength(text) > 80000000) throw new Error('回測 CSV 超過 80 MB');
  const rows = csvRows(text), header=Object.keys(rows[0] ?? {});
  if (!['symbol','open','high','low','close','volume_shares'].every(h => header.includes(h))
    || !(header.includes('at') || header.includes('date'))) throw new Error('回測 CSV 欄位需為 symbol,at（或 date）,open,high,low,close,volume_shares');
  const daily = !header.includes('at'), points:HistoryPoint[]=[];
  for (const r of rows) {
    if (daily && !validDay(r.date!)) throw new Error('回測 CSV 日期不合法');
    const at = daily ? r.date+'T13:30:00+08:00' : r.at!;
    const p:HistoryPoint={symbol:r.symbol!,at,open:r.open!,high:r.high!,low:r.low!,close:r.close!,volume_shares:Number(r.volume_shares)};
    if(r.amount_twd)p.amount_twd=r.amount_twd;
    for (const h of ['bid','ask'] as const) if (r[h]) p[h]=r[h];
    for (const h of ['bid_shares','ask_shares'] as const) if (r[h]) p[h]=Number(r[h]);
    points.push(HistoryPointSchema.parse(p));
  }
  return validateDataset({source:'使用者匯入 CSV（未由程式驗證原始供應商）',synthetic:false,frequency:daily?'DAILY':'MINUTE',points,names:{},
    limitations:daily?['日 K 僅重播假設盤中起點的開盤價及 13:30 收盤價；不還原當日高低點路徑、零股撮合或盤中停損',
      '日 K 假設開盤價在 09:10 與 09:11 維持不變，深度以此前一日成交量估計；這是成交模型假設']:[]});
}
export function syntheticDataset(start: string, end: string): HistoryDataset {
  const store=new Store(':memory:'), calendar=new TradingCalendar(store,true), points:HistoryPoint[]=[];
  try { for(let day=addDays(start,-150);day<=end;day=addDays(day,1)) {
    if(!calendar.isOpen(day)) continue;
    const dayIndex=Math.floor(Date.parse(day)/86400000);
    for(let m=550;m<=810;m+=10) for(let n=0;n<12;n++) {
      const at=`${day}T${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00+08:00`;
      const base=30+n*2, wave=Math.sin(dayIndex*.14+n)*.04+Math.sin((m-550)/65+n)*.01;
      const close=roundPrice(base*(1+wave)), high=d(close).plus(tickSize(close)).toFixed(),low=d(close).minus(tickSize(close)).toFixed();
      points.push({symbol:String(9001+n),at,open:close,high,low,close,volume_shares:3000000+n*25000});
    }
  }} finally {store.close();}
  return validateDataset({source:'SYNTHETIC：虛構股票、行情及成交，不是歷史市場績效',synthetic:true,frequency:'MINUTE',points,names:{},limitations:['虛構行情只驗證程式流程，不能用於判斷策略獲利能力']});
}
export class HistoricalMarket implements Broker {
  readonly production=false; dirty=false; generation=0;
  readonly points:HistoryPoint[];
  private watched=new Set<string>(); private wholeLots=false;
  private bySymbol=new Map<string,HistoryPoint[]>(); private daily=new Map<string,Bar[]>();
  private dailyLast=new Map<string,string>();
  private firstQuote=new Map<string,string>();
  constructor(readonly dataset:HistoryDataset,readonly participation:string) {
    for(const p of dataset.points)if(!this.firstQuote.has(p.symbol))this.firstQuote.set(p.symbol,p.at);
    for(const p of [...(dataset.daily_history??[]),...dataset.points]) {const rows=this.bySymbol.get(p.symbol)??[];rows.push(p);this.bySymbol.set(p.symbol,rows);}
    for(const [symbol,rows] of this.bySymbol) {
      const days=new Map<string,Bar>();
      for(const p of rows) {const day=twDay(new Date(p.at)),old=days.get(day);
        this.dailyLast.set(symbol+':'+day,p.at);
        days.set(day,{date:day,close:Number(p.close),high:Math.max(old?.high??0,Number(p.high)),
          low:Math.min(old?.low??Infinity,Number(p.low)),volume:(old?.volume??0)+p.volume_shares,
          ...(p.amount_twd!==undefined&&(!old||old.amount!==undefined)?{amount:d(old?.amount??0).plus(p.amount_twd).toFixed()}:{})});}
      this.daily.set(symbol,[...days.values()]);
    }
    if(dataset.frequency==='DAILY') {
      this.points=dataset.points.flatMap(p => {
        const day=twDay(new Date(p.at)),previous=this.daily.get(p.symbol)!.filter(b=>b.date<day).at(-1);
        const starts:HistoryPoint[]=['09:10','09:11'].map(clock=>({...p,at:new Date(`${day}T${clock}:00+08:00`).toISOString(),
          high:p.open,low:p.open,close:p.open,volume_shares:Math.floor((previous?.volume??0)/270),amount_twd:undefined,
          bid:undefined,ask:undefined,bid_shares:undefined,ask_shares:undefined}));
        return [...starts,p];
      }).sort((a,b)=>a.at.localeCompare(b.at)||a.symbol.localeCompare(b.symbol));
      this.bySymbol.clear();for(const p of this.points) {const rows=this.bySymbol.get(p.symbol)??[];rows.push(p);this.bySymbol.set(p.symbol,rows);}
    } else this.points=dataset.points;
  }
  private latest(symbol:string,now:Date): HistoryPoint|undefined {
    const rows=this.bySymbol.get(symbol)??[],at=now.toISOString();let lo=0,hi=rows.length;
    while(lo<hi) {const mid=Math.floor((lo+hi)/2);if(rows[mid]!.at<=at)lo=mid+1;else hi=mid;}
    return rows[lo-1];
  }
  async connect():Promise<void>{} async close():Promise<void>{}
  async account():Promise<Account>{throw new Error('歷史行情源沒有交易帳戶');}
  async reconcile():Promise<Order[]>{return [];}
  async subscribe(symbols:string[],wholeLots:boolean):Promise<void>{symbols.forEach(s=>this.watched.add(s));this.wholeLots=wholeLots;}
  quotes(now:Date):Quote[] {
    return [...this.watched].flatMap(symbol=>{const p=this.latest(symbol,now);if(!p||p.at!==now.toISOString())return [];
      if(this.dataset.daily_history&&(!this.firstQuote.has(symbol)||p.at<this.firstQuote.get(symbol)!))return [];
      const last=roundPrice(p.close), tick=tickSize(last), bid=p.bid??roundPrice(d(last).minus(tick)),ask=p.ask??roundPrice(d(last).plus(tick),false);
      const depth=Math.floor(d(p.volume_shares).times(this.participation).toNumber());
      return (this.wholeLots?[true,false]:[true]).map(odd=>({symbol,last,bid,ask,odd,simulated:false,
        trade_at:p.at,book_at:p.at,bid_shares:p.bid_shares??depth,ask_shares:p.ask_shares??depth}));});
  }
  private previousDays(symbol:string,now:Date):Bar[]{return (this.daily.get(symbol)??[]).filter(b=>b.date<twDay(now));}
  async history(symbol:string,now:Date):Promise<Bar[]> {
    const today=twDay(now);
    return (this.daily.get(symbol)??[]).filter(b=>{
      if(b.date<today)return true;if(b.date!==today||twClock(now)<'13:40')return false;
      const last=this.dailyLast.get(symbol+':'+today);
      // Include today's aggregate only after all its rows have occurred and a closing bar exists.
      return !!last&&last<=now.toISOString()&&twClock(new Date(last))>='13:30';
    }).slice(-150);
  }
  async instruments(symbols:string[],now:Date):Promise<Record<string,Instrument>> {
    const result:Record<string,Instrument>={};
    for(const symbol of symbols) {const p=this.latest(symbol,now),previous=this.previousDays(symbol,now).at(-1);if(!p||!previous)continue;
      result[symbol]={symbol,name:this.dataset.names[symbol]?.name??symbol,exchange:this.dataset.names[symbol]?.exchange??'TSE',
        kind:'STOCK',category:'HISTORICAL_SIMULATION',reference:String(previous.close),limit_down:roundPrice(d(previous.close).times('.9'),false),
        limit_up:roundPrice(d(previous.close).times('1.1')),suspended:false,disposition:false,attention:false,verified_at:now.toISOString()};}
    return result;
  }
  async discover(count:number,now:Date):Promise<Candidate[]> {
    const result:Candidate[]=[];
    const pool=this.dataset.daily_universe?.[twDay(now)];
    // A loaded future entrant must stay invisible until its dated membership becomes effective.
    if(this.dataset.daily_universe&&!pool)return [];
    for(const symbol of pool?.symbols??this.bySymbol.keys()) {const p=this.latest(symbol,now),previous=this.previousDays(symbol,now).at(-1);if(!p||!previous)continue;
      result.push({symbol,name:this.dataset.names[symbol]?.name??(this.dataset.synthetic?'虛構股票 '+symbol:symbol),
        last:p.close,amount:previous.amount??d(previous.close).times(previous.volume).toFixed(),source:pool?`${pool.asof} 歷史排行每日股票池`:'歷史資料池：以前一已完成交易日成交金額排序'});}
    return result.sort((a,b)=>d(b.amount).cmp(a.amount)).slice(0,count);
  }
  async submit():Promise<Order>{throw new Error('歷史行情源禁止真實委託');}
  async cancel():Promise<Order>{throw new Error('歷史行情源禁止真實撤單');}
}
/** This CSV contains retained minute rows only; JSON is the complete replay dataset including membership and daily history. */
export function replayMinutesCsv(dataset:HistoryDataset):string {
  const columns=['symbol','at','open','high','low','close','volume_shares','amount_twd'] as const;
  return '\uFEFF'+columns.join(',')+'\r\n'+dataset.points.map(p=>columns.map(k=>String(p[k]??'')).join(',')).join('\r\n');
}

