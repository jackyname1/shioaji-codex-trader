import type { BacktestRequest } from '../core/backtest.js';
export interface DesktopState { status: string; logs: string[]; settings: string; connected: boolean; error: string;
  backtest:string; backtest_running:boolean; backtest_report:boolean; experience:string; codex_login:string }
export interface TraderBridge {
  state(): Promise<DesktopState>;
  command(input: string): Promise<string>;
  saveSettings(text: string): Promise<string>;
  configure(mode: string): Promise<string>;
  authorizeLive(ack: string): Promise<string>;
  backtest(request:BacktestRequest):Promise<string>;
  cancelBacktest():Promise<string>;
  exportBacktest(format:'json'|'csv'):Promise<string>;
  loginCodex():Promise<string>;
  minimize(): Promise<void>;
  exit(): Promise<void>;
}
