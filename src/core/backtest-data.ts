import { z } from 'zod';
import { csvRows } from './facts.js';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { roundPrice, tickSize } from './risk.js';
import { addDays, d, twDay, SessionSchema,type SessionDay, type Account, type Bar, type Candidate, type Instrument, type Order, type Quote } from './models.js';
import type { Broker } from '../broker/types.js';

export const validDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const price = z.string().regex(/^\d+(?:\.\d+)?$/).refine(v => d(v).gt(0));
export const HistoryPointSchema = z.strictObject({
  symbol:z.string().regex(/^[1-9]\d{3}$/), at:z.string().datetime({offset:true}),
  open:price,high:price,low:price,close:price,volume_shares:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bid:price.optional(),ask:price.optional(),bid_shares:z.number().int().nonnegative().optional(),ask_shares:z.number().int().nonnegative().optional(),
}).refine(x => d(x.high).gte(x.open) && d(x.high).gte(x.close) && d(x.low).lte(x.open) && d(x.low).lte(x.close), 'OHLC 範圍不符')
  .refine(x => (x.bid === undefined) === (x.ask === undefined) && (!x.bid || d(x.bid).lte(x.ask!)), '買賣報價不符');
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;
export interface HistoryDataset {
  source:string; synthetic:boolean; frequency:'MINUTE'|'DAILY'; points:HistoryPoint[];
  names:Record<string,{name:string;exchange:'TSE'|'OTC'}>; limitations:string[];
  calendar?:SessionDay[];
}
export function validateDataset(input: HistoryDataset): HistoryDataset {
  if (!input.points.length || input.points.length > 1000000) throw new Error('回測資料必須有 1–1,000,000 筆行情');
  if (new Set(input.points.map(p => p.symbol)).size > 100) throw new Error('回測最多 100 個普通股票');
  const points = input.points.map(p => HistoryPointSchema.parse(p)).map(p => ({...p,at:new Date(p.at).toISOString()}))
    .sort((a,b) => a.at.localeCompare(b.at) || a.symbol.localeCompare(b.symbol));
  const seen = new Set<string>();
  for (const p of points) { const key=p.symbol+':'+p.at;
    if (seen.has(key)) throw new Error('回測資料有重複的股票／時間'); seen.add(key); }
  return {...input,points,...(input.calendar?{calendar:input.calendar.map(s=>SessionSchema.parse(s))}:{})};
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
      points.push({symbol:String(9001+n),at,open:close,high,low,close,volume_shares:1000000+n*25000});
    }
  }} finally {store.close();}
  return validateDataset({source:'SYNTHETIC：虛構股票、行情及成交，不是歷史市場績效',synthetic:true,frequency:'MINUTE',points,names:{},limitations:['虛構行情只驗證程式流程，不能用於判斷策略獲利能力']});
}
export class HistoricalMarket implements Broker {
  readonly production=false; dirty=false; generation=0;
  readonly points:HistoryPoint[];
  private watched=new Set<string>(); private wholeLots=false;
  private bySymbol=new Map<string,HistoryPoint[]>(); private daily=new Map<string,Bar[]>();
  constructor(readonly dataset:HistoryDataset,readonly participation:string) {
    for(const p of dataset.points) {const rows=this.bySymbol.get(p.symbol)??[];rows.push(p);this.bySymbol.set(p.symbol,rows);}
    for(const [symbol,rows] of this.bySymbol) {
      const days=new Map<string,Bar>();
      for(const p of rows) {const day=twDay(new Date(p.at)),old=days.get(day);
        days.set(day,{date:day,close:Number(p.close),high:Math.max(old?.high??0,Number(p.high)),
          low:Math.min(old?.low??Infinity,Number(p.low)),volume:(old?.volume??0)+p.volume_shares});}
      this.daily.set(symbol,[...days.values()]);
    }
    if(dataset.frequency==='DAILY') {
      this.points=dataset.points.flatMap(p => {
        const day=twDay(new Date(p.at)),previous=this.daily.get(p.symbol)!.filter(b=>b.date<day).at(-1);
        const starts:HistoryPoint[]=['09:10','09:11'].map(clock=>({...p,at:new Date(`${day}T${clock}:00+08:00`).toISOString(),
          high:p.open,low:p.open,close:p.open,volume_shares:Math.floor((previous?.volume??0)/270),
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
      const last=roundPrice(p.close), tick=tickSize(last), bid=p.bid??roundPrice(d(last).minus(tick)),ask=p.ask??roundPrice(d(last).plus(tick),false);
      const depth=Math.floor(d(p.volume_shares).times(this.participation).toNumber());
      return (this.wholeLots?[true,false]:[true]).map(odd=>({symbol,last,bid,ask,odd,simulated:false,
        trade_at:p.at,book_at:p.at,bid_shares:p.bid_shares??depth,ask_shares:p.ask_shares??depth}));});
  }
  async history(symbol:string,now:Date):Promise<Bar[]> {return (this.daily.get(symbol)??[]).filter(b=>b.date<twDay(now)).slice(-150);}
  async instruments(symbols:string[],now:Date):Promise<Record<string,Instrument>> {
    const result:Record<string,Instrument>={};
    for(const symbol of symbols) {const p=this.latest(symbol,now),previous=(await this.history(symbol,now)).at(-1);if(!p||!previous)continue;
      result[symbol]={symbol,name:this.dataset.names[symbol]?.name??symbol,exchange:this.dataset.names[symbol]?.exchange??'TSE',
        kind:'STOCK',category:'HISTORICAL_SIMULATION',reference:String(previous.close),limit_down:roundPrice(d(previous.close).times('.9'),false),
        limit_up:roundPrice(d(previous.close).times('1.1')),suspended:false,disposition:false,attention:false,verified_at:now.toISOString()};}
    return result;
  }
  async discover(count:number,now:Date):Promise<Candidate[]> {
    const result:Candidate[]=[];
    for(const symbol of this.bySymbol.keys()) {const p=this.latest(symbol,now),previous=(await this.history(symbol,now)).at(-1);if(!p||!previous)continue;
      result.push({symbol,name:this.dataset.names[symbol]?.name??(this.dataset.synthetic?'虛構股票 '+symbol:symbol),
        last:p.close,amount:d(previous.close).times(previous.volume).toFixed(),source:'歷史資料池：以前一已完成交易日成交金額排序'});}
    return result.sort((a,b)=>d(b.amount).cmp(a.amount)).slice(0,count);
  }
  async submit():Promise<Order>{throw new Error('歷史行情源禁止真實委託');}
  async cancel():Promise<Order>{throw new Error('歷史行情源禁止真實撤單');}
}
