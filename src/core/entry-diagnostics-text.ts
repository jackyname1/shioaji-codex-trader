import type {EntryDiagnostics} from './entry-diagnostics.js';
/** Browser-safe presentation; counts are not prices or trading thresholds. */
export function entryDiagnosticText(x:EntryDiagnostics|undefined):string{
  if(!x)return '舊報表未統計進場診斷；重新執行後可查看';
  const ratio=x.buy_orders?(x.filled_buy_orders/x.buy_orders*100).toFixed(1):'0.0';
  return `買進提案 ${x.buy_signals}（反彈 ${x.rebound_signals}／移動退場 ${x.trailing_signals}）；規則啟用 ${x.rule_rounds}/${x.strategy_rounds} 輪\n`
    +`無交集 ${x.invalid_windows}／窄區間 ${x.narrow_windows}；買單 ${x.buy_orders}、至少成交一股 ${x.filled_buy_orders}（${ratio}%）、完全未成交 ${x.unfilled_buy_orders}\n`
    +`監測 ${x.monitor_samples} 時點；等待樣本為每時點／股票狀態，包含持倉退出等待，並非獨立機會或拒單數\n`
    +(x.unique_entries?`獨立進場訊號 ${x.unique_entries.signals}；曾等待／阻擋 ${x.unique_entries.blocked_signals}。各原因可重疊：`
      +Object.entries(x.unique_entries.reason_categories).map(([k,v])=>k+' '+v).join(' · ')+'\n'+x.unique_entries.definition+'\n':'')
    +x.waits.map(w=>`${w.reason}：${w.samples}`).join(' · ');
}
