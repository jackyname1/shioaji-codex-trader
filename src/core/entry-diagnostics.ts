import type {Analysis,Features,Instrument,Order} from './models.js';
import {entryWindow} from './entry-window.js';

export interface EntryDiagnostics {
  strategy_rounds:number;buy_signals:number;rebound_signals:number;trailing_signals:number;rule_rounds:number;
  invalid_windows:number;narrow_windows:number;monitor_samples:number;
  waits:{reason:string;samples:number}[];buy_orders:number;filled_buy_orders:number;unfilled_buy_orders:number;
}
export class EntryDiagnosticTracker {
  private counts=new Map<string,number>();
  private stats={strategy_rounds:0,buy_signals:0,rebound_signals:0,trailing_signals:0,rule_rounds:0,
    invalid_windows:0,narrow_windows:0,monitor_samples:0};
  strategy(analysis:Analysis,features:Record<string,Features>,metadata:Record<string,Instrument>,now:Date):void{
    this.stats.strategy_rounds++;if(analysis.screening?.entry)this.stats.rule_rounds++;
    for(const b of analysis.decisions.filter(d=>d.action==='BUY')){
      this.stats.buy_signals++;if(b.entry_when==='REBOUND')this.stats.rebound_signals++;if(b.smart?.trailing_fraction)this.stats.trailing_signals++;
      const w=entryWindow(b,features[b.symbol],now,metadata[b.symbol]);if(w.issue)this.stats.invalid_windows++;if(w.narrow)this.stats.narrow_windows++;
    }
  }
  monitor(states:Map<string,{state:string;reason:string;source:string}>):void{
    this.stats.monitor_samples++;
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
    const buys=orders.filter(o=>o.action==='BUY');return {...this.stats,
      waits:[...this.counts].map(([reason,samples])=>({reason,samples})).sort((a,b)=>b.samples-a.samples),
      buy_orders:buys.length,filled_buy_orders:buys.filter(o=>o.filled>0).length,unfilled_buy_orders:buys.filter(o=>!o.filled).length};
  }
}
