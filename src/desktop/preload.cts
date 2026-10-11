import { contextBridge, ipcRenderer } from 'electron';
import type { TraderBridge } from './shared.js';
const bridge: TraderBridge = {
  state: () => ipcRenderer.invoke('trader:state'),
  command: (input: string) => ipcRenderer.invoke('trader:command',input),
  saveSettings: (text: string) => ipcRenderer.invoke('trader:settings',text),
  configure: (mode: string) => ipcRenderer.invoke('trader:configure',mode),
  authorizeLive: () => ipcRenderer.invoke('trader:authorize'),
  backtest: request => ipcRenderer.invoke('trader:backtest',request),
  cancelBacktest: () => ipcRenderer.invoke('trader:backtest-cancel'),
  exportBacktest: format => ipcRenderer.invoke('trader:backtest-export',format),
  selectBacktest: id => ipcRenderer.invoke('trader:backtest-select',id),
  loginCodex: method => ipcRenderer.invoke('trader:codex-login',method),
  openCodexLogin: () => ipcRenderer.invoke('trader:codex-open'),
  testCodex: () => ipcRenderer.invoke('trader:codex-test'),
  selectFile: kind => ipcRenderer.invoke('trader:file',kind),
  connectApi: input => ipcRenderer.invoke('trader:connect-api',input),
  connectSaved: () => ipcRenderer.invoke('trader:connect-saved'),
  forgetCredentials: () => ipcRenderer.invoke('trader:forget-credentials'),
  chart: request => ipcRenderer.invoke('trader:chart',request),
  replayControl: command => ipcRenderer.invoke('trader:replay-control',command),
  replaySpeed: speed => ipcRenderer.invoke('trader:replay-speed',speed),
  exportMarket: () => ipcRenderer.invoke('trader:export-market'),
  minimize: () => ipcRenderer.invoke('trader:hide'),
  exit: () => ipcRenderer.invoke('trader:exit'),
};
contextBridge.exposeInMainWorld('trader',bridge);
