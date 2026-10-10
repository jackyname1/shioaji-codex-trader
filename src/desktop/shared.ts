import type { BacktestRequest,BacktestReport,BacktestProgress } from '../core/backtest.js';
import type { BacktestSummary } from '../core/backtest-controller.js';
import type { WatchState } from '../core/watchlist.js';
import type { Account,Order,Plan,Protection,Quote,Settings } from '../core/models.js';
import type { AnalystEvent } from '../core/codex.js';
import type { ConnectionInput } from './credentials.js';
import type { ChartData,ChartRequest } from '../core/chart.js';
import type { ReplayFrame } from '../core/backtest.js';
export interface RuntimeView {
  mode:Settings['mode'];auto:boolean;paused:boolean;killed:boolean;blocked:boolean;connected:boolean;session:boolean;
  account:Account|null;plan:Plan|null;protections:Protection[];orders:Order[];quotes:Quote[];watch:WatchState;
  next_strategy_at:string|null;analyzing:boolean;scanning:boolean;analysis_status:string;last_monitor_at:string;
  decisions:{symbol:string;state:string;reason:string;source:string}[];
  features:Record<string,import('../core/models.js').Features>;metadata:Record<string,import('../core/models.js').Instrument>;
}
export interface DesktopState { status: string; logs: string[]; settings: string; connected: boolean; error: string;
  backtest:string; backtest_running:boolean; backtest_report:boolean; experience:string; codex_login:string;
  runtime:RuntimeView|null;backtest_progress:BacktestProgress;backtest_result:BacktestReport|null;
  backtest_history:BacktestSummary[];backtest_comparisons:BacktestSummary[];
  connection:{status:string;remembered:boolean;encrypted:boolean;busy:boolean;has_ca:boolean};analyst_events:(AnalystEvent&{context:'live'|'replay'})[];
  replay:ReplayFrame|null;replay_paused:boolean;replay_speed:number;replay_symbols:{symbol:string;name:string}[];
  codex_models:string[] }
export interface TraderBridge {
  state(): Promise<DesktopState>;
  command(input: string): Promise<string>;
  saveSettings(text: string): Promise<string>;
  configure(mode: string): Promise<string>;
  authorizeLive(ack: string): Promise<string>;
  backtest(request:BacktestRequest):Promise<string>;
  cancelBacktest():Promise<string>;
  exportBacktest(format:'json'|'csv'):Promise<string>;
  selectBacktest(id:string):Promise<string>;
  loginCodex():Promise<string>;
  selectFile(kind:'ca'):Promise<string>;
  connectApi(input:ConnectionInput):Promise<string>;
  connectSaved():Promise<string>;
  forgetCredentials():Promise<string>;
  chart(request:ChartRequest):Promise<ChartData>;
  replayControl(command:'pause'|'resume'|'step'):Promise<string>;
  replaySpeed(speed:number):Promise<string>;
  exportMarket():Promise<string>;
  minimize(): Promise<void>;
  exit(): Promise<void>;
}
