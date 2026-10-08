import { contextBridge, ipcRenderer } from 'electron';
import type { TraderBridge } from './shared.js';
const bridge: TraderBridge = {
  state: () => ipcRenderer.invoke('trader:state'),
  command: (input: string) => ipcRenderer.invoke('trader:command',input),
  saveSettings: (text: string) => ipcRenderer.invoke('trader:settings',text),
  configure: (mode: string) => ipcRenderer.invoke('trader:configure',mode),
  authorizeLive: (ack: string) => ipcRenderer.invoke('trader:authorize',ack),
  minimize: () => ipcRenderer.invoke('trader:hide'),
  exit: () => ipcRenderer.invoke('trader:exit'),
};
contextBridge.exposeInMainWorld('trader',bridge);
