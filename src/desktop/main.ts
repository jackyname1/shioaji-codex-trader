import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, powerSaveBlocker,
  type IpcMainInvokeEvent } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync,readFileSync,writeFileSync,statSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { TradingService, LIVE_ACK } from '../core/service.js';
import { SettingsSchema,active, type Settings } from '../core/models.js';
import { Store } from '../core/store.js';
import { loopbackOrigin } from '../broker/http.js';
import type { DesktopState } from './shared.js';
import { bundledCodexPath,codexEnvironment } from '../core/codex.js';
import { BacktestController } from '../core/backtest-controller.js';
import { BacktestRequestSchema,fillsCsv } from '../core/backtest.js';
import { experienceStatus } from '../core/experience.js';

let window: BrowserWindow | undefined, tray: Tray | undefined, service: TradingService | undefined;
let quitting = false, initialError = '', blocker: number | undefined;
const smoke = process.argv.includes('--smoke-test');
const argsMode = process.argv.find(a => a.startsWith('--mode='))?.slice(7);
let mode = SettingsSchema.shape.mode.parse(argsMode??'demo');
const directory = dirname(fileURLToPath(import.meta.url));
let dataRoot = '';
let backtest:BacktestController;
let loginTask:Promise<void>|undefined,loginAbort:AbortController|undefined,loginStatus='尚未從程式啟動 Codex 登入；也可沿用本機 Codex auth.json';
let preferences:{last_mode:Settings['mode'];connections:Partial<Record<Settings['mode'],{base_url:string;stock_account_index:number}>>}={last_mode:'demo',connections:{}};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',() => { window?.show(); window?.focus(); });
  app.on('window-all-closed',() => { /* tray continues */ });
  app.on('before-quit',event => { if (!quitting) { event.preventDefault(); void exit(); } });
  void app.whenReady().then(async () => {
    dataRoot = smoke ? mkdtempSync(join(tmpdir(),'shioaji-ts-smoke-')) : join(app.getPath('userData'),'state');
    if(!smoke)try{const p=JSON.parse(readFileSync(join(dataRoot,'desktop-settings.json'),'utf8')) as typeof preferences;
      SettingsSchema.shape.mode.parse(p.last_mode);for(const c of Object.values(p.connections))if(c){loopbackOrigin(c.base_url);SettingsSchema.shape.stock_account_index.parse(c.stock_account_index);}
      preferences=p;if(!argsMode)mode=p.last_mode==='live'&&process.env.LIVE_TRADING!=='true'?'readonly':p.last_mode;
    }catch{/* New or malformed preferences start in DEMO. */}
    backtest=new BacktestController(join(dataRoot,'backtests'));await backtest.restore();
    await connect(mode);
    createWindow(); createTray(); registerIpc();
    if (service?.engine.settings.keep_awake) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (service?.engine.settings.start_minimized && tray && !smoke) window!.hide();
    if (smoke) await smokeTest();
  }).catch(error => { console.error(smoke ? error : '桌面啟動失敗'); app.exit(1); });
}
async function connect(nextMode: Settings['mode'],override?:Settings): Promise<void> {
  if (service) await service.close(); service = undefined; initialError = ''; mode = nextMode;
  try {
    const c=override??preferences.connections[mode],base=c?loopbackOrigin(c.base_url):'http://127.0.0.1:8080',index=c?.stock_account_index??0;
    const suffix=base==='http://127.0.0.1:8080'&&index===0?'':'-'+createHash('sha256').update(JSON.stringify([base,index])).digest('hex').slice(0,12);
    const path=join(dataRoot,`${mode}${suffix}.db`);
    if(c){const store=new Store(path);try{store.saveSettings(SettingsSchema.parse({...store.settings(),...(override??{}),mode,base_url:base,stock_account_index:index,...(override?{auto_execute:false}:{})}));}finally{store.close();}}
    service = new TradingService(path,mode);
    preferences.last_mode=mode;preferences.connections[mode]={base_url:base,stock_account_index:index};
    if(!smoke)writeFileSync(join(dataRoot,'desktop-settings.json'),JSON.stringify(preferences),{mode:0o600});
    await service.start(!smoke);
  }
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
      catch (e) { throw new Error(e instanceof Error && /^(?:回測|用法|未知指令|委託 ID|實盤|每種|交易模式|須先|目前模式|請先|尚未|上一輪|程式正在|無法|本輪|自動|設定|停止)/.test(e.message)
        ? e.message : '操作未完成，請核對本機狀態與設定'); }
    });
  };
  handle('trader:state',() => ({status:service?.engine.status(new Date()) ?? '',logs:service?.store.logs() ?? [],
    settings:JSON.stringify(service?.engine.settings ?? SettingsSchema.parse({mode}),null,2),
    connected:service?.engine.connected ?? false,error:initialError,backtest:backtest.text(),backtest_running:backtest.progress.running,
    backtest_report:!!backtest.report,experience:service?experienceStatus(service.store,service.engine.settings,new Date().toISOString()):'',codex_login:loginStatus} satisfies DesktopState));
  handle('trader:command',async value => {
    if (typeof value !== 'string' || value.length > 2000 || !service) throw new Error('未知指令或程式尚未啟動');
    if (value.trim() === 'exit') { await exit(); return '結束程式'; }
    return service.command(value);
  });
  handle('trader:settings',async value => {
    if (typeof value !== 'string' || value.length > 20000 || !service) throw new Error('設定內容不合法');
    const settings = SettingsSchema.parse(JSON.parse(value));
    if(settings.mode!==mode)throw new Error('設定中的模式需使用「切換並重新連線」變更');
    if(settings.base_url!==service.engine.settings.base_url||settings.stock_account_index!==service.engine.settings.stock_account_index){
      loopbackOrigin(settings.base_url);
      if(service.store.orders(true).length||service.engine.account?.orders.some(active))throw new Error('目前仍有未完成委託，不能變更連線設定');
      await connect(mode,settings);return initialError||'設定已儲存並重新連線；新連線設定使用獨立資料庫，自動執行已關閉，請先核對帳戶';
    }
    await service.saveSettings(settings);
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
  handle('trader:backtest',async value=>{
    if(!service)throw new Error('回測需要有效的本機設定');
    const request=BacktestRequestSchema.parse(value);let csv:string|undefined;
    if(request.source==='csv'){
      const result=await dialog.showOpenDialog(window!,{title:'匯入歷史行情 CSV（含至少 20 個交易日暖機資料）',properties:['openFile'],filters:[{name:'CSV',extensions:['csv']}]});
      if(result.canceled)return '已取消匯入';const path=result.filePaths[0]!;
      if(statSync(path).size>80000000)throw new Error('回測 CSV 超過 80 MB');csv=readFileSync(path,'utf8');
    }
    return backtest.start(request,service.engine.settings,csv);
  });
  handle('trader:backtest-cancel',()=>backtest.cancel());
  handle('trader:codex-login',()=>{
    if(smoke)throw new Error('Codex 登入不在測試流程執行');if(loginTask)return 'Codex 登入仍在進行';
    const profile=join(dataRoot,'codex-login');mkdirSync(profile,{recursive:true,mode:0o700});
    loginAbort=new AbortController();loginStatus='已啟動官方 Codex 登入，請在瀏覽器完成；有效期限五分鐘';
    loginTask=promisify(execFile)(bundledCodexPath(),['-c','cli_auth_credentials_store="file"','login'],{
      env:codexEnvironment(process.env,profile),timeout:300000,windowsHide:true,signal:loginAbort.signal})
      .then(()=>{loginStatus='Codex 登入完成。請將 codex_enabled 設為 true，或按「啟用 Codex 定時分析」。';})
      .catch(()=>{loginStatus='Codex 登入未完成。請確認瀏覽器、網路與帳戶權限；也可依 README 使用官方 CLI 登入。';})
      .finally(()=>{loginTask=undefined;});return loginStatus;
  });
  handle('trader:backtest-export',async value=>{
    if(!backtest.report||!['json','csv'].includes(String(value)))throw new Error('回測沒有可匯出的報表');
    const format=value as 'json'|'csv',result=await dialog.showSaveDialog(window!,{
      title:'匯出歷史模擬報表',defaultPath:`backtest-${backtest.report.request.start}-${backtest.report.request.end}.${format}`,
      filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(result.canceled||!result.filePath)return '已取消匯出';
    writeFileSync(result.filePath,format==='json'?JSON.stringify(backtest.report,null,2):fillsCsv(backtest.report),{mode:0o600});return '回測報表已匯出';
  });
  handle('trader:exit',() => exit());
}
async function smokeTest(): Promise<void> {
  if (!window || !service || initialError || mode !== 'demo') throw new Error('桌面測試未啟動');
  if (process.platform === 'win32' && !tray) throw new Error('Windows 系統匣未啟動');
  const version = await promisify(execFile)(bundledCodexPath(),['--version'],{timeout:20000,windowsHide:true});
  if (!version.stdout.includes('codex')) throw new Error('Codex 打包執行檔無法啟動');
  if (!window.webContents.isLoading()) await verifyRenderer();
  else await new Promise<void>((resolve,reject) => {
    window!.webContents.once('did-finish-load',() => { void verifyRenderer().then(resolve,reject); });
    window!.webContents.once('did-fail-load',() => reject(new Error('視窗未載入')));
  });
  await service.command('auto on'); await service.command('pause');
  if (!service.engine.pausedEntries || !service.engine.settings.auto_execute) throw new Error('指令測試失敗');
  await service.command('resume');
  backtest.start({start:'2026-10-01',end:'2026-10-08',source:'sample',strategy:'demo',initial_cash:'100000'},service.engine.settings);
  await backtest.wait();
  if(!backtest.report||backtest.report.status!=='COMPLETED'||!backtest.report.metrics.filled_orders)throw new Error('打包後歷史模擬未通過');
  const before = window.isVisible(); window.hide(); if (window.isVisible()) throw new Error('隱藏測試失敗');
  window.show(); if (before && !window.isVisible()) throw new Error('重開測試失敗');
  console.log('Electron text interface, isolated IPC, commands, historical simulation and window hide/show: PASS'); await exit();
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
  loginAbort?.abort();await loginTask;
  backtest?.cancel();await backtest?.wait();
  await service?.close(); service = undefined;
  if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  tray?.destroy(); window?.destroy();
  if (smoke) rmSync(dataRoot,{recursive:true,force:true}); app.quit();
}
