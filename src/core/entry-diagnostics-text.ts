import type {EntryDiagnostics} from './entry-diagnostics.js';
const strategyLabels:Record<string,string>={PULLBACK_REBOUND:'反彈',TREND_CONTINUATION:'趨勢',BREAKOUT_CONFIRM:'突破'};
/** Browser-safe presentation; counts are not prices or trading thresholds. */
export function entryDiagnosticText(x:EntryDiagnostics|undefined):string{
  if(!x)return '舊報表未統計進場診斷；重新執行後可查看';
  const ratio=x.buy_orders?(x.filled_buy_orders/x.buy_orders*100).toFixed(1):'0.0';
  return `買進提案 ${x.buy_signals}（反彈 ${x.rebound_signals}／移動退場 ${x.trailing_signals}）；規則啟用 ${x.rule_rounds}/${x.strategy_rounds} 輪\n`
    +(x.program_setups?'程式設定（同股互斥）：'+Object.entries(x.program_setups).map(([key,n])=>(strategyLabels[key]??key)+':'+n).join(' · ')+'\n':'')
    +`無交集 ${x.invalid_windows}／窄區間 ${x.narrow_windows}；買單 ${x.buy_orders}、至少成交一股 ${x.filled_buy_orders}（${ratio}%）、完全未成交 ${x.unfilled_buy_orders}\n`
    +`監測 ${x.monitor_samples} 時點；等待樣本為每時點／股票狀態，包含持倉退出等待，並非獨立機會或拒單數\n`
    +(x.idle_reasons?'分類狀態樣本：'+x.idle_reasons.map(c=>({NO_SIGNAL:'無有效訊號',TRIGGER_WAIT:'觸發等待',REWARD_RISK:'報酬風險不足',COST:'成本過高',BUYING_POWER:'購買力不足',SETTLEMENT:'交割款未可用',ORDER_SYMBOL_LIMIT:'部位／單筆限制',DATA:'行情／資料不足',ORDER_REJECTED:'訂單遭拒',DAILY_LOSS:'日損失鎖定',OTHER:'其他'}[c.category])+':'+c.samples).join(' · ')+'\n':'')
    +(x.capital_idle?'未達目標的行情時點 '+x.capital_idle.samples+'；平均目標差額 '+x.capital_idle.average_target_gap_twd+' 元（狀態歸因，非時間加權／錯失獲利）\n':'')
    +x.waits.map(w=>`${w.reason}：${w.samples}`).join(' · ');
}
