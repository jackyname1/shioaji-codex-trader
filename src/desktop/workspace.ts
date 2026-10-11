import type { DesktopState, RuntimeView } from './shared.js';

export function simulationView(state: DesktopState): boolean { return state.runtime?.mode !== 'live'; }
export function replayView(state:DesktopState):boolean{return simulationView(state)&&state.simulation_scope!=='realtime';}
export function workspaceCutoff(state: DesktopState): string {
  return replayView(state) ? state.replay?.at ?? state.backtest_result?.asof ?? '' : new Date().toISOString();
}
export function workspaceRuntime(state: DesktopState): RuntimeView | null {
  const runtime = state.runtime;
  if (!runtime || !replayView(state)) return runtime;
  const frame = state.replay, report = state.backtest_result;
  const account = frame?.account ?? (report ? { asof: report.asof, cash: report.metrics.final_cash,
    settlement_debits: '0', settlement_credits: report.metrics.settlement_credits, positions: report.positions,
    orders: report.orders, complete: true, issue: '', daily_buy_amount: '0', daily_buy_count: 0 } : null);
  // All panes use one historical scope. In particular do not borrow present-day
  // quotes, metadata, indicators, strategy expiry, or decisions from the live service.
  return { ...runtime, account, quotes: frame?.quotes ?? [], features: {}, metadata: {},
    plan: frame?.plan ?? null, protections: frame?.protections ?? [], orders: account?.orders.filter(o=>!['FILLED','CANCELLED','REJECTED'].includes(o.status)) ?? [],
    watch: frame?.watch ?? { ...runtime.watch, entries: [], changes: report?.watch_changes ?? [],
      asof: report?.asof ?? '', healthy: false, issue: report ? '已載入保存的模擬結果' : '等待開始模擬' },
    decisions: frame?.decisions??(frame?.plan?.analysis.decisions ?? []).map(d => ({ symbol: d.symbol, state: 'WAIT', reason: d.reason, source: 'REPLAY' })),
    next_strategy_at: null, analyzing: state.backtest_progress.running && ['ANALYSIS','REVIEW'].includes(state.backtest_progress.phase),
    sizing:state.backtest_progress.running&&state.backtest_progress.phase==='SIZING',execution_queue:frame?.execution_queue??[],
    analysis_status: state.backtest_progress.message, scanning: false, last_monitor_at: frame?.last_monitor_at??frame?.at??'',
    auto: state.backtest_progress.running, paused: state.replay_paused, session: !!frame,
    blocked: false, killed: state.backtest_progress.phase === 'CANCELLED' };
}
export function workspaceEvents(state: DesktopState): DesktopState['analyst_events'] {
  const cutoff = workspaceCutoff(state);
  return state.analyst_events.filter(event => {
    if (replayView(state)) return event.context === 'replay' && !!cutoff && Date.parse(event.asof) <= Date.parse(cutoff);
    return event.context !== 'replay';
  });
}
