import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, powerSaveBlocker,
  type IpcMainInvokeEvent } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TradingService, LIVE_ACK } from '../core/service.js';
import { SettingsSchema, type Settings } from '../core/models.js';
import type { DesktopState } from './shared.js';

let window: BrowserWindow | undefined, tray: Tray | undefined, service: TradingService | undefined;
let quitting = false, initialError = '', blocker: number | undefined;
const smoke = process.argv.includes('--smoke-test');
const argsMode = process.argv.find(a => a.startsWith('--mode='))?.slice(7) ?? 'demo';
let mode = SettingsSchema.shape.mode.parse(argsMode);
const directory = dirname(fileURLToPath(import.meta.url));
let dataRoot = '';

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',() => { window?.show(); window?.focus(); });
  app.on('window-all-closed',() => { /* tray continues */ });
  app.on('before-quit',event => { if (!quitting) { event.preventDefault(); void exit(); } });
  void app.whenReady().then(async () => {
    dataRoot = smoke ? mkdtempSync(join(tmpdir(),'shioaji-ts-smoke-')) : join(app.getPath('userData'),'state');
    await connect(mode);
    createWindow(); createTray(); registerIpc();
    if (service?.engine.settings.keep_awake) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (service?.engine.settings.start_minimized && tray && !smoke) window!.hide();
    if (smoke) await smokeTest();
  }).catch(error => { console.error(smoke ? error : '桌面啟動失敗'); app.exit(1); });
}
async function connect(nextMode: Settings['mode']): Promise<void> {
  if (service) await service.close(); service = undefined; initialError = ''; mode = nextMode;
  try { service = new TradingService(join(dataRoot,`${mode}.db`),mode); await service.start(!smoke); }
  catch { initialError = mode === 'demo' ? '模擬程式啟動失敗' : '無法連接或核對 Shioaji 服務。請啟動官方本機服務，並檢查 CA、版本與帳戶設定。'; }
}
function createWindow(): void {
  window = new BrowserWindow({width:1080,height:800,minWidth:720,minHeight:500,title:'Shioaji Codex Trader — TypeScript',
    backgroundColor:'#10151c',show:false,webPreferences:{preload:join(directory,'preload.cjs'),nodeIntegration:false,
      contextIsolation:true,sandbox:true,webSecurity:true}});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.once('ready-to-show',() => window?.show());
  window.on('close',event => { if (!quitting && tray) { event.preventDefault(); window?.hide(); } });
  window.on('minimize',() => { if (tray) window?.hide(); });
  void window.loadFile(join(directory,'index.html'));
}
function trayIcon(): Electron.NativeImage {
  const size = 16, stride = size * 4, buffer = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * stride + x * 4, highlight = x >= 3 && x <= 12 && y >= 4 && y <= 6 || x >= 7 && x <= 9 && y >= 4 && y <= 12;
    buffer[offset] = highlight ? 170 : 32; buffer[offset + 1] = highlight ? 220 : 24;
    buffer[offset + 2] = highlight ? 70 : 16; buffer[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(buffer,{width:size,height:size});
}
function createTray(): void {
  try {
    tray = new Tray(trayIcon()); tray.setToolTip('Shioaji Codex Trader');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'開啟文字介面',click:() => {window?.show();window?.focus();}},
      {label:'暫停新增買進',click:() => void service?.command('pause').catch(() => undefined)},
      {label:'停止全部新委託',click:() => void service?.command('stop').catch(() => undefined)},
      {type:'separator'},{label:'結束程式',click:() => void exit()},
    ]));
    tray.on('click',() => { window?.show(); window?.focus(); });
    tray.on('double-click',() => { window?.show(); window?.focus(); });
  } catch { tray = undefined; /* When no system tray is available, closing the window is a real exit. */
    window?.on('closed',() => void exit()); }
}
function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('無效的桌面 IPC 來源');
}
function registerIpc(): void {
  const handle = (name: string, action: (value: unknown) => unknown | Promise<unknown>): void => {
    ipcMain.handle(name,async (event,value: unknown) => {
      trusted(event);
      try { return await action(value); }
      catch (e) { throw new Error(e instanceof Error && /^(?:用法|未知指令|委託 ID|實盤|每種|交易模式|須先|目前模式|請先|尚未|上一輪|程式正在|無法|本輪|自動|設定|停止)/.test(e.message)
        ? e.message : '操作未完成，請核對本機狀態與設定'); }
    });
  };
  handle('trader:state',() => ({status:service?.engine.status(new Date()) ?? '',logs:service?.store.logs() ?? [],
    settings:JSON.stringify(service?.engine.settings ?? SettingsSchema.parse({mode}),null,2),
    connected:service?.engine.connected ?? false,error:initialError} satisfies DesktopState));
  handle('trader:command',async value => {
    if (typeof value !== 'string' || value.length > 2000 || !service) throw new Error('未知指令或程式尚未啟動');
    if (value.trim() === 'exit') { await exit(); return '結束程式'; }
    return service.command(value);
  });
  handle('trader:settings',async value => {
    if (typeof value !== 'string' || value.length > 20000 || !service) throw new Error('設定內容不合法');
    const settings = SettingsSchema.parse(JSON.parse(value)); await service.saveSettings(settings);
    if (settings.keep_awake && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!settings.keep_awake && blocker !== undefined) {powerSaveBlocker.stop(blocker);blocker=undefined;}
    return '設定已儲存至本機 SQLite';
  });
  handle('trader:configure',async value => {
    const next = SettingsSchema.shape.mode.parse(value);
    if (service?.store.orders(true).length) throw new Error('目前模式仍有未完成委託，請先核對並處理');
    if (next === 'live') {
      const answer = await dialog.showMessageBox(window!,{type:'warning',buttons:['取消','開啟實盤監控'],defaultId:0,cancelId:0,
        message:'切換到實盤帳戶監控',detail:'自動交易需另外完成本機授權並啟用 auto on。請先使用 readonly 核對券商帳戶、交割與可賣庫存。'});
      if (answer.response !== 1) return '已取消切換';
    }
    await connect(next); return initialError || '已切換到 ' + next;
  });
  handle('trader:authorize',async value => {
    if (value !== LIVE_ACK || !service) throw new Error('實盤授權文字不符');
    const answer = await dialog.showMessageBox(window!,{type:'warning',buttons:['取消','授權本機實盤'],defaultId:0,cancelId:0,
      message:'授權這個程式自動交易現股',detail:'開始前會檢查硬性風控。今日買進零股無法當沖；智慧停損不保證成交。授權後需另行 auto on。'});
    if (answer.response !== 1) return '已取消授權';
    await service.activateLive(String(value)); return '已授權本機實盤；需另外 auto on';
  });
  handle('trader:hide',() => { if (tray) window?.hide(); else window?.minimize(); });
  handle('trader:exit',() => exit());
}
async function smokeTest(): Promise<void> {
  if (!window || !service || initialError || mode !== 'demo') throw new Error('桌面測試未啟動');
  if (process.platform === 'win32' && !tray) throw new Error('Windows 系統匣未啟動');
  if (!window.webContents.isLoading()) await verifyRenderer();
  else await new Promise<void>((resolve,reject) => {
    window!.webContents.once('did-finish-load',() => { void verifyRenderer().then(resolve,reject); });
    window!.webContents.once('did-fail-load',() => reject(new Error('視窗未載入')));
  });
  await service.command('auto on'); await service.command('pause');
  if (!service.engine.pausedEntries || !service.engine.settings.auto_execute) throw new Error('指令測試失敗');
  await service.command('resume');
  const before = window.isVisible(); window.hide(); if (window.isVisible()) throw new Error('隱藏測試失敗');
  window.show(); if (before && !window.isVisible()) throw new Error('重開測試失敗');
  console.log('Electron text interface, isolated IPC, commands and window hide/show: PASS'); await exit();
}
async function verifyRenderer(): Promise<void> {
  const result = await window!.webContents.executeJavaScript(`(async () => ({ bridge: typeof window.trader?.state === 'function',
    node: typeof window.require, status: (await window.trader.state()).status,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content }))()`);
  if (!result.bridge || result.node !== 'undefined' || !result.status.includes('TypeScript') || !result.csp) throw new Error('安全 IPC 或文字介面未載入');
}
async function exit(): Promise<void> {
  if (quitting) return;
  const pending = service?.store.orders(true).length ?? 0;
  if (pending && !smoke) {
    const answer = await dialog.showMessageBox(window!,{type:'warning',buttons:['繼續監控','結束程式'],defaultId:0,cancelId:0,
      message:`仍有 ${pending} 筆未完成委託`,detail:'結束後本機智慧條件停止監控，券商掛單仍存在。可先用 cancel-all 核對撤單。'});
    if (answer.response !== 1) return;
  }
  quitting = true;
  await service?.close(); service = undefined;
  if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  tray?.destroy(); window?.destroy();
  if (smoke) rmSync(dataRoot,{recursive:true,force:true}); app.quit();
}
