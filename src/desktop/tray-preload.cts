import {contextBridge,ipcRenderer} from 'electron';
import type {TraySnapshot} from './dashboard.js';
export interface TrayBridge {state():Promise<TraySnapshot>;open(target:'workspace'|'settings'|'diagnostics'|'strategy',symbol?:string):Promise<void>;hide():Promise<void>}
const bridge:TrayBridge={state:()=>ipcRenderer.invoke('tray:state'),open:(target,symbol)=>ipcRenderer.invoke('tray:open',{target,symbol}),hide:()=>ipcRenderer.invoke('tray:hide')};
contextBridge.exposeInMainWorld('overview',bridge);
