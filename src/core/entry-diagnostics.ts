import {d,equity,type Account,type Settings,type Analysis,type Features,type Instrument,type Order,type Decision} from './models.js';
import {capitalSnapshot} from './capital.js';
import {entryWindow} from './entry-window.js';
import {IDLE_CATEGORIES,idleCategory,type IdleCategory} from './performance.js';

export interface EntryDiagnostics {
  strategy_rounds:number;buy_signals:number;rebound_signals:number;trailing_signals:number;rule_rounds:number;
  invalid_windows:number;narrow_windows:number;monitor_samples:number;
  waits:{reason:string;samples:number}[];buy_orders:number;filled_buy_orders:number;unfilled_buy_orders:number;
  idle_reasons?:{category:IdleCategory;samples:number}[];state_transitions?:number;
  program_setups?:Record<string,number>;strategy_orders?:Record<string,number>;
  capital_idle?:{scope:'MARKET_EVENT_SAMPLES';samples:number;average_target_gap_twd:string;
    reasons:{category:IdleCategory;samples:number;average_target_gap_twd:string}[]};
}
export class EntryDiagnosticTracker {
  private counts=new Map<string,number>();
  private causes=new Map<IdleCategory,number>();private previous=new Map<string,string>();private transitions=0;
  private setups=new Set<string>();private program:Record<string,number>={};
  private idle=new Map<IdleCategory,{n:number;gap:ReturnType<typeof d>}>();private idleSamples=0;private gapSum=d(0);
  adaptive(planId:string,decisions:Decision[]):void{
    for(const d of decisions){const key=planId+':'+d.symbol+':'+d.entry_strategy;if(this.setups.has(key))continue;
      this.setups.add(key);const kind=d.entry_strategy??'MODEL';this.program[kind]=(this.program[kind]??0)+1;}
  }
  private stats={strategy_rounds:0,buy_signals:0,rebound_signals:0,trailing_signals:0,rule_rounds:0,
    invalid_windows:0,narrow_windows:0,monitor_samples:0};
  strategy(analysis:Analysis,features:Record<string,Features>,metadata:Record<string,Instrument>,now:Date):void{
    this.stats.strategy_rounds++;if(analysis.screening?.entry)this.stats.rule_rounds++;
    for(const b of analysis.decisions.filter(d=>d.action==='BUY')){
      this.stats.buy_signals++;if(b.entry_when==='REBOUND')this.stats.rebound_signals++;if(b.smart?.trailing_fraction)this.stats.trailing_signals++;
      const w=entryWindow(b,features[b.symbol],now,metadata[b.symbol]);if(w.issue)this.stats.invalid_windows++;if(w.narrow)this.stats.narrow_windows++;
    }
  }
  monitor(states:Map<string,{state:string;reason:string;source:string}>,context?:{
    account:Account;settings:Settings;qualified:number;healthy:boolean;dailyLoss:boolean;market:boolean}):void{
    this.stats.monitor_samples++;
    if(context?.market){
      const a=context.account,s=context.settings,c=capitalSnapshot(a,s),gap=d(c.target_gap_twd);
      if(gap.gt(0)){
        const room=d(a.cash).minus(a.settlement_debits).minus(c.reserved_buy_cash_twd).minus(c.minimum_cash_reserve_twd);
        let category:IdleCategory;
        if(context.dailyLoss)category='DAILY_LOSS';
        else if(!a.complete||!context.healthy)category='DATA';
        else if(!context.qualified)category='NO_SIGNAL';
        else if(room.lte(0))category=d(a.settlement_credits).gt(0)&&room.plus(a.settlement_credits).gt(0)?'SETTLEMENT':'BUYING_POWER';
        else if(a.daily_buy_count>=s.max_daily_buy_orders||d(a.daily_buy_amount).gte(equity(a).times(s.max_daily_buy_fraction)))category='ORDER_SYMBOL_LIMIT';
        else{
          const counts=new Map<IdleCategory,number>();
          for(const [symbol,state] of states)if(!a.positions.some(p=>p.symbol===symbol&&p.shares)&&state.source!=='PROTECTION'
            &&['HOLD','WAIT','BLOCKED','SIZE_FAILED','TRACKING','EXPIRED','REJECTED'].includes(state.state)){
            const key=idleCategory(state.state==='HOLD'?'HOLD':state.reason);counts.set(key,(counts.get(key)??0)+1);
          }
          category=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0]??'NO_SIGNAL';
        }
        const old=this.idle.get(category)??{n:0,gap:d(0)};old.n++;old.gap=old.gap.plus(gap);this.idle.set(category,old);
        this.idleSamples++;this.gapSum=this.gapSum.plus(gap);
      }
    }
    for(const [symbol,s] of states){
      const value=s.state+':'+s.reason;if(this.previous.get(symbol)!==value){this.transitions++;this.previous.set(symbol,value);}
      if(['HOLD','WAIT','BLOCKED','SIZE_FAILED','TRACKING','EXPIRED','REJECTED'].includes(s.state)){
        const category=idleCategory(s.state==='HOLD'?'HOLD':s.reason);this.causes.set(category,(this.causes.get(category)??0)+1);
      }
    }
    for(const s of states.values())if(s.state==='WAIT'||s.state==='BLOCKED'||s.state==='SIZE_FAILED'){
      // Normalize moving prices so a changing low/MA does not create an unbounded report.
      const reason=s.reason.startsWith('進場價格條件無交集')?'進場價格條件無交集':s.reason.startsWith('條件未成立')?'額外 AND 條件未成立':
        /等待(高於|低於|跌至)|等待回升|追蹤低點/.test(s.reason)?'價格／反彈門檻未觸發':
        /行情|交易時段/.test(s.reason)?'等待新鮮行情／交易時段':/資格|觀測資料/.test(s.reason)?'觀測資格／資料未確認':
        /暫停/.test(s.reason)?'新買進已暫停':/可賣|當沖/.test(s.reason)?'等待可賣庫存':
        /條件資料/.test(s.reason)?'條件資料未就緒':/資金|現金|上限|風險|報酬|費/.test(s.reason)?'預算／風控／成本限制':'其他等待或數量確認未完成';
      this.counts.set(reason,(this.counts.get(reason)??0)+1);
    }
  }
  report(orders:Order[]):EntryDiagnostics{
    const buys=orders.filter(o=>o.action==='BUY'),byStrategy:Record<string,number>={};
    for(const o of buys)byStrategy[o.entry_strategy??'MODEL_OR_LEGACY_RULE']=(byStrategy[o.entry_strategy??'MODEL_OR_LEGACY_RULE']??0)+1;
    return {...this.stats,program_setups:this.program,strategy_orders:byStrategy,state_transitions:this.transitions,
      capital_idle:{scope:'MARKET_EVENT_SAMPLES',samples:this.idleSamples,average_target_gap_twd:this.idleSamples?this.gapSum.div(this.idleSamples).toFixed(4):'0',
        reasons:IDLE_CATEGORIES.map(category=>{const v=this.idle.get(category);return {category,samples:v?.n??0,average_target_gap_twd:v?v.gap.div(v.n).toFixed(4):'0'};})},
      idle_reasons:IDLE_CATEGORIES.map(category=>({category,samples:this.causes.get(category)??0})),
      waits:[...this.counts].map(([reason,samples])=>({reason,samples})).sort((a,b)=>b.samples-a.samples),
      buy_orders:buys.length,filled_buy_orders:buys.filter(o=>o.filled>0).length,unfilled_buy_orders:buys.filter(o=>!o.filled).length};
  }
}
