import { Store } from '../src/core/store.js';
import { TradingCalendar } from '../src/core/calendar.js';
import { Engine } from '../src/core/engine.js';
import { PaperBroker, SyntheticMarket } from '../src/broker/paper.js';
import { SettingsSchema, type Account, type Instrument, type Order, type Quote, type Snapshot } from '../src/core/models.js';
export const now = new Date('2026-10-08T10:00:00+08:00');
export const settings = () => SettingsSchema.parse({mode:'demo',auto_execute:true});
export const quote = (at = now): Quote => ({symbol:'9001',last:'30',bid:'29.95',ask:'30.05',
  trade_at:at.toISOString(),book_at:at.toISOString(),odd:true,simulated:false,bid_shares:17,ask_shares:17});
export const instrument = (at = now): Instrument => ({symbol:'9001',name:'虛構股票',exchange:'TSE',category:'DEMO',kind:'STOCK',
  reference:'30',limit_down:'27',limit_up:'33',suspended:false,disposition:false,attention:false,verified_at:at.toISOString()});
export const account = (): Account => ({asof:now.toISOString(),cash:'100000',settlement_debits:'0',settlement_credits:'0',
  positions:[],orders:[],complete:true,issue:'',daily_buy_amount:'0',daily_buy_count:0});
export const order = (values: Partial<Order> = {}): Order => ({local_id:'abcdef123456',tag:'abcdef',broker_id:'',symbol:'9001',
  action:'BUY',shares:30,limit_price:'30.05',lot:'ODD',status:'PREPARED',filled:0,created_at:now.toISOString(),plan_id:'test',purpose:'ENTRY',...values});
export const snapshot = (): Snapshot => ({snapshot_id:'snapshot',asof:now.toISOString(),synthetic:true,review_only:false,
  account:{cash:'100000',settlement_debits:'0',settlement_credits:'0',equity:'100000',positions:[],open_orders:[],daily_buy_amount:'0',daily_buy_count:0},
  universe:Array.from({length:5},(_,i) => ({symbol:String(9001+i),name:'虛構',last:'30',amount:'1000000',source:'SYNTHETIC'})),
  features:Object.fromEntries(Array.from({length:5},(_,i) => [String(9001+i),{sufficient:true,sessions:60}])),
  hard_limits:{plan_max_minutes:120},existing_protection:{},fundamentals:{},news:[],data_limitations:[]});
export class ControlledMarket extends SyntheticMarket {
  marketPrice = '30'; depth = 17;
  override quotes(at: Date): Quote[] { return [{...quote(at),last:this.marketPrice,bid:String(Number(this.marketPrice)-.05),ask:String(Number(this.marketPrice)+.05),bid_shares:this.depth,ask_shares:this.depth}]; }
  override async instruments(symbols: string[], at: Date): Promise<Record<string,Instrument>> {
    return Object.fromEntries(symbols.map(symbol => [symbol,{...instrument(at),symbol}]));
  }
  override async discover(count: number, _at: Date) { return snapshot().universe.slice(0,count); }
}
export async function rig(store = new Store(':memory:')) {
  const s = settings(), calendar = new TradingCalendar(store,true), market = new ControlledMarket();
  const broker = new PaperBroker(store,market,s,calendar), engine = new Engine(store,broker,s,calendar);
  await engine.start(now);
  const input = await engine.snapshot(now);
  const analysis = {snapshot_id:input.snapshot_id,expires_at:new Date(now.getTime()+7200000).toISOString(),stance:'BUY_ALLOWED',
    candidates:input.universe.slice(0,5).map(x => x.symbol),summary:'test',decisions:[{symbol:'9001',action:'BUY',shares:30,
      limit_price:'30.05',entry_when:'IMMEDIATE',trigger_price:'0',reason:'test',
      smart:{stop_price:'29',take_profit:'35',trailing_activate:'33',trailing_fraction:'0.03'}}]};
  await engine.activate(analysis as never,input,now); return {store,s,calendar,market,broker,engine};
}
