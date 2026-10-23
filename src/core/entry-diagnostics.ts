import type {Analysis,Features,Instrument,Order} from './models.js';
import {entryWindow} from './entry-window.js';
import {waitCategory} from './performance.js';

export interface EntryDiagnostics {
  strategy_rounds:number;buy_signals:number;rebound_signals:number;trailing_signals:number;rule_rounds:number;
  invalid_windows:number;narrow_windows:number;monitor_samples:number;
  waits:{reason:string;samples:number}[];buy_orders:number;filled_buy_orders:number;unfilled_buy_orders:number;
  reason_categories?:Record<string,number>;state_transitions?:number;
  unique_entries?:{signals:number;blocked_signals:number;reason_categories:Record<string,number>;
    definition:string;signals_with_reasons:{plan_id:string;symbol:string;source:string;categories:string[]}[]};
}
export class EntryDiagnosticTracker {
  private counts=new Map<string,number>();
  private planId='';
  private entries=new Map<string,{plan_id:string;symbol:string;source:string;categories:Set<string>}>();
  private entry(symbol:string,source:string){
    const key=this.planId+':'+symbol;
    let row=this.entries.get(key);
    if(!row){row={plan_id:this.planId,symbol,source,categories:new Set<string>()};this.entries.set(key,row);}
    return row;
  }
  private categories:Record<string,number>={};private previous=new Map<string,string>();private transitions=0;
  private stats={strategy_rounds:0,buy_signals:0,rebound_signals:0,trailing_signals:0,rule_rounds:0,
    invalid_windows:0,narrow_windows:0,monitor_samples:0};
  strategy(analysis:Analysis,features:Record<string,Features>,metadata:Record<string,Instrument>,now:Date,planId=now.toISOString()):void{
    this.planId=planId;
    this.stats.strategy_rounds++;if(analysis.screening?.entry)this.stats.rule_rounds++;
    for(const b of analysis.decisions.filter(d=>d.action==='BUY')){
      this.entry(b.symbol,'CODEX');this.stats.buy_signals++;if(b.entry_when==='REBOUND')this.stats.rebound_signals++;if(b.smart?.trailing_fraction)this.stats.trailing_signals++;
      const w=entryWindow(b,features[b.symbol],now,metadata[b.symbol]);if(w.issue)this.stats.invalid_windows++;if(w.narrow)this.stats.narrow_windows++;
    }
  }
  monitor(states:Map<string,{state:string;reason:string;source:string}>):void{
    this.stats.monitor_samples++;
    for(const [symbol,s] of states)if(['WAIT','BLOCKED','SIZE_FAILED','TRACKING','EXPIRED','HOLD','REJECTED'].includes(s.state)){
      const category=waitCategory(s.reason);this.categories[category]=(this.categories[category]??0)+1;
      // A plan/symbol is one signal across all samples, reasons and cross-session ROD retries.
      // Sell/protection waiting states are never manufactured into buy opportunities.
      if(this.planId&&s.source!=='PROTECTION'&&(s.source==='RULE'||this.entries.has(this.planId+':'+symbol)))
        this.entry(symbol,s.source).categories.add(category);
      const key=s.state+':'+category;if(this.previous.get(symbol)!==key){this.transitions++;this.previous.set(symbol,key);}
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
    const buys=orders.filter(o=>o.action==='BUY');
    for(const o of buys){const key=o.plan_id+':'+o.symbol;if(!this.entries.has(key))
      this.entries.set(key,{plan_id:o.plan_id,symbol:o.symbol,source:o.purpose,categories:new Set<string>()});}
    const entries=[...this.entries.values()],uniqueCategories:Record<string,number>={};
    for(const row of entries)for(const category of row.categories)uniqueCategories[category]=(uniqueCategories[category]??0)+1;
    return {...this.stats,reason_categories:this.categories,state_transitions:this.transitions,
      unique_entries:{signals:entries.length,blocked_signals:entries.filter(e=>e.categories.size>0).length,reason_categories:uniqueCategories,
        definition:'每份成功策略／股票為一個訊號；跨日重掛與重複掃描不重計。同一訊號可有多個等待原因，原因數不可相加為機會數。未觀測的篩選階段不推定通過。',
        signals_with_reasons:entries.map(e=>({...e,categories:[...e.categories].sort()}))},
      waits:[...this.counts].map(([reason,samples])=>({reason,samples})).sort((a,b)=>b.samples-a.samples),
      buy_orders:buys.length,filled_buy_orders:buys.filter(o=>o.filled>0).length,unfilled_buy_orders:buys.filter(o=>!o.filled).length};
  }
}
