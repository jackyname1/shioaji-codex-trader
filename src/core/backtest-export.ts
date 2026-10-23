import {tradeAttribution} from './trade-attribution.js';
import {d,twDay} from './models.js';
import {tradeStatistics} from './performance.js';
import {auditBacktest} from './backtest-audit.js';
import type {BacktestReport} from './backtest.js';

export type BacktestExportFormat='json'|'csv'|'trades'|'daily'|'audit'|'orders'|'failures'|'funnel'|'rejections'|'strategies'|'decisions'|'attribution';
export interface BacktestDiagnostics {
  version:1;
  trades:ReturnType<typeof tradeStatistics>;
  audit:ReturnType<typeof auditBacktest>;
  attribution?:ReturnType<typeof tradeAttribution>;
  evaluation:{status:'ACCOUNTING_ERROR'|'FLOW_TEST'|'INCOMPLETE'|'NOT_PROFITABLE'|'INSUFFICIENT_SAMPLE'|'VALIDATION_REQUIRED';message:string};
  coverage:{observed_sessions:number;valid_plan_sessions:number;buy_allowed_sessions:number;no_valid_plan_days:string[]};
  findings:{code:string;message:string}[];
  completeness:{at:string;stage:string;code:string;issue:string}[];
}
/** Describes observed results only; never tunes parameters or extends an expired plan. */
export function backtestDiagnostics(r:BacktestReport):BacktestDiagnostics {
  const audit=auditBacktest(r),findings:BacktestDiagnostics['findings']=[];
  let trades:ReturnType<typeof tradeStatistics>;
  try{trades=tradeStatistics(r.fills,r.orders);}catch{trades=tradeStatistics([]);}
  let attribution:ReturnType<typeof tradeAttribution>|undefined;try{attribution=tradeAttribution(r.fills,r.orders);}catch{findings.push({code:'ATTRIBUTION_INVALID_FILL',message:'原始成交無法建立有效 FIFO 交易歸因。'});}
  const evaluation:BacktestDiagnostics['evaluation']=!audit.passed
    ?{status:'ACCOUNTING_ERROR',message:'帳務重算未通過，先修正紀錄與計算，不能採用本次獲利結果。'}
    :r.synthetic?{status:'FLOW_TEST',message:'虛構資料只驗證程式流程，未驗證市場獲利。'}
    :r.status!=='COMPLETED'||audit.stale_valuation_symbols.length?{status:'INCOMPLETE',message:'回測未完整完成或期末估值過期，績效驗證尚未通過。'}
    :d(audit.net_pnl_after_estimated_exit_costs??r.metrics.net_pnl).lte(0)?{status:'NOT_PROFITABLE',message:'扣除已支付成本及期末估計賣出費稅後未獲利，尚未達到獲利要求。'}
    :trades.closed_trades<20?{status:'INSUFFICIENT_SAMPLE',message:'本段估計淨損益為正，但完整平倉樣本不足；仍需增加樣本及樣本外驗證。'}
    :{status:'VALIDATION_REQUIRED',message:'本段估計淨損益為正；仍須獨立期間、保守成交與模擬交易驗證，尚不能據此判定可實盤。'};
  if(!audit.passed)findings.push({code:'ACCOUNTING_ERROR',message:'獨立成交重算失敗：'+audit.checks.filter(c=>!c.passed).map(c=>c.code).join('、')+'。'});
  if(audit.stale_valuation_symbols.length)findings.push({code:'STALE_VALUATION',message:`期末 ${audit.stale_valuation_symbols.join('、')} 的估值行情距該日收盤或回測截止超過五分鐘，或沒有有效估值時間；陳舊價格可能扭曲損益。`});
  if(audit.estimated_remaining_exit_costs!==null&&r.positions.some(p=>p.shares>0))findings.push({code:'ESTIMATED_EXIT_COSTS',message:`期末庫存另估賣出費稅 ${audit.estimated_remaining_exit_costs} 元，扣除後淨損益 ${audit.net_pnl_after_estimated_exit_costs} 元。僅沿用末價估算，未假設已賣出，亦未計未來滑價與排隊風險。`});
  const plans=r.strategy_log.filter(p=>!p.review).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const days=[...new Set(r.daily_equity.filter(row=>row.day<=twDay(new Date(r.asof))).map(row=>row.day))];
  let valid=0,buyAllowed=0;const gaps:string[]=[];
  for(const day of days){
    const opening=r.request.whole_lots||day>='2026-12-07'?'09:00':'09:10';
    const start=Math.max(Date.parse(day+'T'+opening+':00+08:00'),Date.parse(r.request.start+'T'+(r.request.start_time??'09:00')+':00+08:00'));
    const end=Math.min(Date.parse(day+'T13:30:00+08:00'),Date.parse(r.asof));
    const active=plans.filter((p,i)=>Math.max(start,Date.parse(p.at))<Math.min(end,
      p.lifecycle==='UNTIL_REPLACED'?Infinity:Date.parse(p.expires_at),Date.parse(plans[i+1]?.at??r.asof)));
    if(active.length)valid++;else if(start<end)gaps.push(day);
    if(active.some(p=>p.stance==='BUY_ALLOWED'))buyAllowed++;
  }
  if(r.status!=='COMPLETED')findings.push({code:'INCOMPLETE',message:`本次狀態 ${r.status}，停止於 ${r.asof}，不能視為完整期間績效。`});
  if(d(r.metrics.net_pnl).lt(0)){
    findings.push({code:'NET_LOSS',message:`扣費後虧損 ${r.metrics.net_pnl} 元。`});
    const gross=r.metrics.gross_pnl;
    if(gross!==undefined)findings.push({code:d(gross).lt(0)?'GROSS_LOSS':'COST_DRAG',message:d(gross).lt(0)
      ?`費用前也虧損 ${gross} 元，虧損不能只歸因於手續費與稅。`
      :`費用前損益 ${gross} 元、已支付成本 ${r.metrics.total_costs} 元，成本使淨損益轉負。`});
  }
  if(trades.closed_trades<20)findings.push({code:'SMALL_SAMPLE',message:`只有 ${trades.closed_trades} 筆完整平倉交易；勝率與期望值為樣本描述，尚不能證明策略優勢。`});
  if(trades.expectancy!==null&&d(trades.expectancy).lt(0))findings.push({code:'NEGATIVE_EXPECTANCY',message:`完整交易平均淨損益 ${trades.expectancy} 元；提高曝險或交易次數不能據此推定改善。`});
  if(r.positions.some(p=>p.shares>0))findings.push({code:'OPEN_POSITION_MARKS',message:`期末仍有未平倉庫存，未實現損益 ${r.metrics.unrealized_pnl} 元已計入淨損益，尚未扣未來賣出成本；不能視為已落袋收益。`});
  const triggerRejects=(r.workflow??[]).filter(e=>e.stage==='RISK'&&e.message.includes('停損不得位於或低於跌停價'));
  if(triggerRejects.length)findings.push({code:'LEGACY_TRIGGER_BAND_REJECTION',message:`舊版曾有 ${triggerRejects.length} 次狀態變更因停損觸發價位於今日跌停或以下而封鎖；跨日觸發條件與當日委託價格不同。修正版須以原始行情重跑，不能直接把遭拒訊號補算為獲利。`});
  if(gaps.length)findings.push({code:'PLAN_COVERAGE_GAP',message:`${days.length} 個已觀測交易日中，${gaps.length} 日盤中沒有有效策略；舊版限時策略或尚未啟用首輪策略可能留下空窗。新版持續策略直到下一輪成功接替。此處僅統計策略覆蓋，不代表缺少行情或一定錯失獲利；既有持倉保護仍持續。`});
  if(r.settings.portfolio_risk_enabled===false)findings.push({code:'PORTFOLIO_GATE_OFF',message:'組合研究風控未啟用；平倉統計仍須顯示，不能把 scale=1 解讀為風險檢查已通過。'});
  if(r.quality.execution_model==='APPROXIMATE')findings.push({code:'APPROXIMATE_FILLS',message:`成交模型為近似（${r.request.fill_assumption??'legacy'}），尚非真實零股排隊與成交證據。`});
  const completeness=(r.failures??[]).map(f=>({at:f.at,stage:f.stage,code:f.diagnostic?.code??'UNCLASSIFIED',issue:f.issue}));
  for(const day of r.quality.missing_sessions)completeness.push({at:day+'T09:00:00+08:00',stage:'DATA',code:'MISSING_SESSION',issue:'交易日缺少行情'});
  for(const symbol of audit.stale_valuation_symbols)completeness.push({at:r.asof,stage:'VALUATION',code:'STALE_VALUATION',issue:symbol+' 期末估值過期；最後行情 '+(r.quality.last_marks[symbol]??'未提供')});
  for(const event of r.quality.corporate_action_exposure??[])completeness.push({at:event.at,stage:'CORPORATE_ACTION',code:'UNRESOLVED_CORPORATE_ACTION',issue:`${event.symbol} 隔夜 ${event.opening_shares} 股未完成公司行動權益／股數核對`});
  if(r.entry_funnel&&!r.entry_funnel.complete)completeness.push({at:r.asof,stage:'DIAGNOSTICS',code:'ENTRY_FUNNEL_TRUNCATED',issue:'未完整保存 '+r.entry_funnel.omitted_signals+' 個唯一訊號'});
  if(r.quality.halt_reason)completeness.push({at:r.asof,stage:'HALT',code:r.quality.halt_reason,issue:'必要決策未完成，回測提前停止'});
  if(r.status==='CANCELLED')completeness.push({at:r.asof,stage:'CANCEL',code:'USER_CANCELLED',issue:'使用者主動停止'});
  if(r.status==='FAILED'&&!completeness.length)completeness.push({at:r.asof,stage:'STRATEGY',code:'NO_VALID_STRATEGY',issue:'沒有有效盤中策略，無法產生可信的策略結果'});
  return {version:1,trades,audit,attribution,evaluation,completeness,coverage:{observed_sessions:days.length,valid_plan_sessions:valid,buy_allowed_sessions:buyAllowed,no_valid_plan_days:gaps},findings};
}
// Protect free-text CSV cells from spreadsheet formulas while retaining negative numeric amounts.
export function csvCell(value:unknown):string {
  let text=String(value??'');if(/^[=+@\-\t\r]/.test(text)&&!/^[-+]?\d+(?:\.\d+)?$/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function csv(fields:string[],rows:unknown[][]):string{return '\uFEFF'+fields.join(',')+(rows.length?'\r\n'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'):'');}
export function diagnosticMarkdown(r:BacktestReport):string {
  const diag=backtestDiagnostics(r),m=r.metrics,t=diag.trades;
  const cell=(s:unknown)=>String(s??'無').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
  const table=(fields:string[],rows:unknown[][])=>['| '+fields.join(' | ')+' |','| '+fields.map(()=>'---').join(' | ')+' |',...rows.map(row=>'| '+row.map(cell).join(' | ')+' |')].join('\n');
  return [`# 回測損益診斷`,`${r.request.start} 至 ${r.request.end} · ${r.status} · 資料截止 ${r.asof}`,
    `報表 ${r.id} · 程式 ${r.build?.version??r.version} · 提交 ${r.build?.source_commit??'未提供'} · ${r.synthetic?'合成示範資料':'歷史資料'}`,
    '## 損益與完整交易',table(['項目','結果'],[
      ['起始資金',m.initial_cash],['期末淨值',m.final_equity],['淨損益／報酬',`${m.net_pnl}／${m.return_pct}%`],
      ['費用前損益',m.gross_pnl],['手續費／稅',`${m.fees}／${m.taxes}`],['已實現／未實現',`${m.realized_pnl}／${m.unrealized_pnl}`],
      ['最大回撤',`${m.max_drawdown_pct}%`],['完整交易／勝／負',`${t.closed_trades}／${t.winning_trades}／${t.losing_trades}`],
      ['完整交易勝率',t.win_rate_pct===null?'無':t.win_rate_pct+'%'],['獲利因子',t.profit_factor_unbounded?'無虧損分母':t.profit_factor],['平均每筆淨損益',t.expectancy],
      ['策略期限覆蓋交易日',`${diag.coverage.valid_plan_sessions}／${diag.coverage.observed_sessions}`],['允許買進的策略覆蓋交易日',diag.coverage.buy_allowed_sessions],
      ['期末庫存估計賣出費稅',diag.audit.estimated_remaining_exit_costs],['再扣期末估計賣出費稅後淨損益',diag.audit.net_pnl_after_estimated_exit_costs],
    ]),'## 績效檢核',diag.evaluation.message,
    '## 獨立帳務稽核',table(['檢查','結果','說明'],diag.audit.checks.map(c=>[c.code,c.passed?'通過':'未通過',c.message])),
    '## 不完整原因',table(['時點（明示時區）','階段','錯誤碼','原因'],diag.completeness.map(f=>[f.at,f.stage,f.code,f.issue])),
    '## 診斷',...diag.findings.map(f=>`- ${f.code}：${f.message}`),
    ...(diag.coverage.no_valid_plan_days.length?['無有效策略日期：'+diag.coverage.no_valid_plan_days.join('、')]:[]),
    '## 完整交易明細（含成本，未平倉不計入勝率）',table(['股票','進場 UTC','出場 UTC','持有小時','淨損益','出場原因'],t.episodes.map(e=>[e.symbol,e.entry_at,e.exit_at,e.holding_hours.toFixed(2),e.pnl,e.exit_reason])),
    '## 執行歸因',diag.attribution?.limitation??'原始成交歸因無法完成',table(['股票','價差損益','手續費','稅','獨立淨損益','報價差成本','模型價格影響'],(diag.attribution?.closed??[]).map(e=>[e.symbol,e.gross_pnl,e.fees,e.taxes,e.net_pnl,e.spread_cost,e.modeled_price_impact])),
    '## 出場原因',table(['原因','完整交易','淨損益'],Object.entries(t.by_exit_reason).map(([k,v])=>[k,v.trades,v.pnl])),
    '## 每日資產',table(['日期','截止 UTC','完整收盤','淨值','現金','待收交割'],r.daily_equity.map(e=>[e.day,e.asof,e.complete,e.equity,e.cash,e.settlement_credits])),
    '## 重現設定', '```json',JSON.stringify({request:r.request,settings:r.settings,quality:r.quality,build:r.build},null,2),'```',
    '## 資料限制',...r.limitations.map(s=>'- '+s),
    '## 驗證範圍','本報告診斷既有結果，不等於修改後已獲利。策略變更須在相同行情、成本與成交假設下重跑，另以未參與調整的期間驗證；不得刪除虧損交易、使用未來資料或為轉正放寬風控。',''].join('\n\n');
}
export function backtestExport(r:BacktestReport,format:BacktestExportFormat):{extension:string;label:string;content:string} {
  if(format==='json')return {extension:'json',label:'完整回測紀錄',content:JSON.stringify({...r,diagnostics:backtestDiagnostics(r)},null,2)};
  if(format==='audit')return {extension:'md',label:'回測損益診斷',content:diagnosticMarkdown(r)};
  if(format==='funnel')return {extension:'csv',label:'唯一訊號漏斗',content:csv(['signal_id','plan_id','symbol','sources','first_at','last_at','stage','passed','not_required','blocked'],
    (r.entry_funnel?.signals??[]).flatMap(s=>Object.entries(s.checks).map(([stage,c])=>[s.id,s.plan_id,s.symbol,s.sources.join(';'),c.first_at,c.last_at,stage,c.passed,c.not_required,c.blocked])))};
  if(format==='rejections')return {extension:'csv',label:'唯一訊號拒絕原因',content:csv(['signal_id','plan_id','symbol','stage','code','reason','first_at','last_at','samples'],
    (r.entry_funnel?.signals??[]).flatMap(s=>s.rejections.map(c=>[s.id,s.plan_id,s.symbol,c.stage,c.code,c.reason,c.first_at,c.last_at,c.samples])))};
  if(format==='strategies')return {extension:'csv',label:'策略變更歷史',content:csv(['at','review','stance','expires_at','lifecycle','selected','summary'],
    r.strategy_log.map(s=>[s.at,s.review,s.stance,s.expires_at,s.lifecycle??'LEGACY',s.selected.join(';'),s.summary]))};
  if(format==='decisions')return {extension:'csv',label:'AI 決策紀錄',content:csv(['id','run_id','sequence','at','asof','stage','purpose','model','reasoning','message','details'],
    (r.analyst_events??[]).map(e=>[e.id,e.run_id,e.sequence,e.at,e.asof,e.stage,e.purpose,e.model,e.reasoning,e.message,e.details===undefined?'':JSON.stringify(e.details)]))};
  if(format==='attribution'){
    const fields=['symbol','entry_at','exit_at','buy_shares','gross_pnl','fees','taxes','net_pnl','reported_realized_pnl','reference_gross_pnl','spread_cost','modeled_price_impact','execution_shortfall','unattributed_price_pnl','exit_reasons','order_ids'] as const;
    const result=tradeAttribution(r.fills,r.orders);
    return {extension:'csv',label:'交易執行歸因',content:csv([...fields],result.closed.map(e=>fields.map(k=>Array.isArray(e[k])?(e[k] as string[]).join(';'):e[k])))};
  }
  if(format==='trades'){
    const fields=['symbol','entry_at','exit_at','holding_hours','pnl','exit_reason'] as const;
    return {extension:'csv',label:'完整交易',content:csv([...fields],backtestDiagnostics(r).trades.episodes.map(e=>fields.map(k=>e[k])))};
  }
  if(format==='daily'){
    const fields=['day','asof','complete','equity','cash','settlement_credits','exposure_pct'] as const;
    return {extension:'csv',label:'每日淨值',content:csv([...fields],r.daily_equity.map(e=>fields.map(k=>e[k])))};
  }
  if(format==='orders'){
    const fields=['local_id','broker_id','tag','created_at','plan_id','symbol','action','purpose','lot','shares','filled','limit_price','status','exit_trigger','trigger_reason'] as const;
    return {extension:'csv',label:'交易委託',content:csv([...fields],r.orders.map(o=>fields.map(k=>o[k])))};
  }
  if(format==='failures'){
    return {extension:'csv',label:'策略失敗與缺資料',content:csv(['at','review','stage','code','issue'],[
      ...backtestDiagnostics(r).completeness.map(f=>[f.at,(r.failures??[]).find(e=>e.at===f.at&&e.stage===f.stage)?.review??false,f.stage,f.code,f.issue]),
    ])};
  }
  if(format!=='csv')throw new Error('回測匯出格式不合法');
  const fields=['id','order_id','at','symbol','action','lot','purpose','shares','price','amount','fee','tax','realized_pnl','exit_trigger','book_source'] as const;
  return {extension:'csv',label:'成交明細',content:csv([...fields],r.fills.map(f=>fields.map(k=>f[k])))};
}
