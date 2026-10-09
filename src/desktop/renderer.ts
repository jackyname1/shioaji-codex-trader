import type { TraderBridge } from './shared.js';
declare global { interface Window { trader: TraderBridge } }
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const message = (text: string): void => { element('message').textContent = text; };
async function run(action: () => Promise<unknown>): Promise<void> {
  try { message(String(await action() ?? '完成')); await refresh(); }
  catch (e) { message(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /,'') : '操作失敗'); }
}
let settingsDirty = false, polling = false;
async function refresh(): Promise<void> {
  if (polling) return; polling = true;
  try { const state = await window.trader.state();
    element('status').textContent = state.status || state.error;
    element('logs').textContent = state.logs.join('\n');
    element('error').textContent = state.error;
    element('backtest').textContent=state.backtest;
    element('experience').textContent=state.experience;
    element('codex-login-status').textContent=state.codex_login;
    element<HTMLButtonElement>('bt-run').disabled=state.backtest_running;
    element<HTMLButtonElement>('bt-json').disabled=!state.backtest_report;
    element<HTMLButtonElement>('bt-csv').disabled=!state.backtest_report;
    if (!settingsDirty) element<HTMLTextAreaElement>('settings').value = state.settings;
  } finally { polling = false; }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]'))
  button.addEventListener('click',() => void run(() => window.trader.command(button.dataset.command!)));
element<HTMLFormElement>('command-form').addEventListener('submit',event => {
  event.preventDefault(); const input = element<HTMLInputElement>('command');
  const command = input.value; input.value = ''; void run(() => window.trader.command(command));
});
element('hide').addEventListener('click',() => void run(() => window.trader.minimize()));
element('exit').addEventListener('click',() => void run(() => window.trader.exit()));
element('switch').addEventListener('click',() => void run(() => window.trader.configure(element<HTMLSelectElement>('mode').value)));
element('authorize').addEventListener('click',() => void run(() => window.trader.authorizeLive(element<HTMLInputElement>('ack').value)));
element('settings').addEventListener('input',() => {settingsDirty=true;});
element('save').addEventListener('click',() => void run(async () => {
  const result = await window.trader.saveSettings(element<HTMLTextAreaElement>('settings').value); settingsDirty=false; return result;
}));
element('reset').addEventListener('click',() => {settingsDirty=false;void refresh();});
element<HTMLFormElement>('backtest-form').addEventListener('submit',event=>{
  event.preventDefault();void run(()=>window.trader.backtest({
    start:element<HTMLInputElement>('bt-start').value,end:element<HTMLInputElement>('bt-end').value,
    initial_cash:element<HTMLInputElement>('bt-cash').value,source:element<HTMLSelectElement>('bt-source').value as 'sample'|'csv'|'shioaji',
    strategy:element<HTMLSelectElement>('bt-strategy').value as 'demo'|'codex',whole_lots:element<HTMLInputElement>('bt-whole').checked,
    decision_interval_minutes:Number(element<HTMLInputElement>('bt-interval').value),max_codex_calls:Number(element<HTMLInputElement>('bt-calls').value),participation:'0.01',
  }));
});
element('bt-cancel').addEventListener('click',()=>void run(()=>window.trader.cancelBacktest()));
element('bt-json').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('json')));
element('bt-csv').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('csv')));
element('bt-source').addEventListener('change',()=>{if(element<HTMLSelectElement>('bt-source').value!=='sample')element<HTMLSelectElement>('bt-strategy').value='codex';});
element('codex-login').addEventListener('click',()=>void run(()=>window.trader.loginCodex()));
element('codex-enable').addEventListener('click',()=>void run(async()=>{
  const state=await window.trader.state(),settings=JSON.parse(state.settings) as Record<string,unknown>;
  settings.codex_enabled=true;return window.trader.saveSettings(JSON.stringify(settings));
}));
void refresh().catch(() => message('文字介面連線失敗'));
setInterval(() => void refresh().catch(() => undefined),1000);
