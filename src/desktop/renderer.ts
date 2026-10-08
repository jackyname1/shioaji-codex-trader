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
void refresh().catch(() => message('文字介面連線失敗'));
setInterval(() => void refresh().catch(() => undefined),1000);
