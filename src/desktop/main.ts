import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, powerSaveBlocker,
  safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync,readFileSync,writeFileSync,statSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TradingService } from '../core/service.js';
import { SettingsSchema,active, type Settings } from '../core/models.js';
import { demoAnalysis } from '../core/strategy.js';
import { Store } from '../core/store.js';
import { loopbackOrigin } from '../broker/http.js';
import { brokerIssue, BrokerError } from '../broker/health.js';
import type { DesktopState } from './shared.js';
import { bundledCodexPath, CodexError, codexEnvironment, prepareCodexProfile } from '../core/codex.js';
import { BacktestController } from '../core/backtest-controller.js';
import { BacktestRequestSchema,fillsCsv } from '../core/backtest.js';
import { experienceStatus } from '../core/experience.js';
import { z } from 'zod';
import { CredentialVault,NativeConnection,ConnectionInputSchema } from './credentials.js';
import { liveChart } from '../core/live-chart.js';
import { ChartRequestSchema } from '../core/chart.js';
import { bundledShioajiPath } from './broker-runtime.js';
import { DesktopOperations } from './operations.js';
import { DesktopSettings } from './settings.js';
import { CodexLogin } from './codex-login.js';

let window: BrowserWindow | undefined, tray: Tray | undefined, service: TradingService | undefined;
let quitting = false, initialError = '', blocker: number | undefined;
const smoke = process.argv.includes('--smoke-test');
const argsMode = process.argv.find(a => a.startsWith('--mode='))?.slice(7);
let mode = SettingsSchema.shape.mode.parse(smoke?'demo':argsMode==='live'?'live':'paper');
const directory = dirname(fileURLToPath(import.meta.url));
let dataRoot = '';
let backtest:BacktestController;
let vault:CredentialVault,nativeConnection:NativeConnection,remembered=false;
let connectionBusy=false,chartBusy=false;const chartAbort=new AbortController();
const operations=new DesktopOperations();let liveActionEpoch=0;
const brokerPath=():Promise<string>=>bundledShioajiPath(app.isPackaged?join(process.resourcesPath,'shioaji'):join(directory,'../../../resources/shioaji'));
let commonSettings:DesktopSettings,codexLogin:CodexLogin;
let preferences:{last_mode:Settings['mode'];connections:Partial<Record<Settings['mode'],{base_url:string;stock_account_index:number}>>}={last_mode:'paper',connections:{}};

if (!smoke&&!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',() => { window?.show(); window?.focus(); });
  app.on('window-all-closed',() => { /* tray continues */ });
  app.on('before-quit',event => { if (!quitting) { event.preventDefault(); void exit(); } });
  void app.whenReady().then(async () => {
    dataRoot = smoke ? mkdtempSync(join(tmpdir(),'shioaji-ts-smoke-')) : join(app.getPath('userData'),'state');
    if(!smoke)try{const p=JSON.parse(readFileSync(join(dataRoot,'desktop-settings.json'),'utf8')) as typeof preferences;
      SettingsSchema.shape.mode.parse(p.last_mode);for(const c of Object.values(p.connections))if(c){loopbackOrigin(c.base_url);SettingsSchema.shape.stock_account_index.parse(c.stock_account_index);}
      preferences=p;if(!argsMode)mode=p.last_mode==='live'?'live':'paper';
    }catch{/* New or malformed preferences start in paper mode. */}
    commonSettings=new DesktopSettings(dataRoot);
    commonSettings.migrate(preferences.last_mode,preferences.connections[preferences.last_mode]?.stock_account_index??0);
    const secure={isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),
      encryptString:safeStorage.encryptString,decryptString:safeStorage.decryptString};
    vault=new CredentialVault(join(dataRoot,'private'),secure);nativeConnection=new NativeConnection(join(dataRoot,'native-service'),brokerPath);
    const saved=await vault.read();remembered=!!saved;
    backtest=new BacktestController(join(dataRoot,'backtests'));await backtest.restore();
    await connect(mode);
    codexLogin=new CodexLogin(join(dataRoot,'codex-login'),url=>shell.openExternal(url),async()=>{
      const selected=service;if(!selected||quitting||selected.engine.settings.codex_enabled)return;
      await selected.saveSettings({...selected.engine.settings,codex_enabled:true});
      if(selected===service)commonSettings.save(selected.engine.settings);
    });
    if(smoke){codexLogin.status.state='signed_out';codexLogin.status.message='隔離測試：不會使用真實 Codex 登入';}
    createWindow(); createTray(); registerIpc();
    if(!smoke)void codexLogin.check();
    if(saved&&!smoke){connectionBusy=true;try{await operations.run(async()=>{await nativeConnection.start(saved);await connect(mode);});}
      catch(error){initialError=error instanceof Error?error.message:'Shioaji 自動登入未完成，請重新連線';}finally{connectionBusy=false;}}
    if(quitting)return;
    if (service?.engine.settings.keep_awake) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (service?.engine.settings.start_minimized && tray && !smoke) window!.hide();
    if (smoke) await smokeTest();
  }).catch(error => { console.error(smoke ? error : '桌面啟動失敗'); app.exit(1); });
}
async function connect(nextMode: Settings['mode'],override?:Settings): Promise<void> {
  if (service) await service.close(); service = undefined; initialError = ''; mode = nextMode;
  try {
    const base=nativeConnection.baseUrl,index=override?.stock_account_index??commonSettings.accountIndex;
    // Database identity belongs to the mode/account, not the automatically chosen port.
    const suffix=index===0?'':'-account-'+index;
    const path=join(dataRoot,`${mode}${suffix}.db`);
    const store=new Store(path);try{
      if(store.get('account_fingerprint')&&store.get('account_identity_version')!==2&&!store.get('legacy_account_origin'))
        store.set('legacy_account_origin',store.settings().base_url);
      store.saveSettings(commonSettings.apply(store.settings(),mode,base,override));
    }finally{store.close();}
    service = new TradingService(path,mode);
    commonSettings.save(service.engine.settings);
    preferences.last_mode=mode;preferences.connections[mode]={base_url:base,stock_account_index:index};
    if(!smoke)writeFileSync(join(dataRoot,'desktop-settings.json'),JSON.stringify(preferences),{mode:0o600});
    if(!smoke)service.engine.setSettings({...service.engine.settings,auto_execute:false});
    if(smoke||nativeConnection.connected)await service.start(!smoke&&mode==='live');
  }
  catch(error) {initialError=mode==='demo'?'模擬程式啟動失敗':brokerIssue(error);}
}
function createWindow(): void {
  window = new BrowserWindow({width:1600,height:960,minWidth:1100,minHeight:680,icon:join(directory,'assets/app.png'),title:'Shioaji Codex Trader',
    backgroundColor:'#0c1016',show:false,webPreferences:{preload:join(directory,'preload.cjs'),nodeIntegration:false,
      contextIsolation:true,sandbox:true,webSecurity:true}});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.once('ready-to-show',() => window?.show());
  window.on('close',event => { if (!quitting && tray) { event.preventDefault(); window?.hide(); } });
  window.on('minimize',() => { if (tray) window?.hide(); });
  void window.loadFile(join(directory,'index.html'));
}
function trayIcon(): Electron.NativeImage { return nativeImage.createFromPath(join(directory,'assets/tray.png')).resize({width:20,height:20}); }
function createTray(): void {
  try {
    tray = new Tray(trayIcon()); tray.setToolTip('Shioaji Codex Trader');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'開啟交易工作台',click:() => {window?.show();window?.focus();}},
      {label:'暫停新增買進',click:() => void service?.command('pause').catch(() => undefined)},
      {label:'停止全部新委託',click:() => {liveActionEpoch++;void service?.command('stop').catch(() => undefined);}},
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
      catch (e) {if(e instanceof BrokerError||e instanceof CodexError)throw new Error(e.message);
        if(e instanceof z.ZodError)throw new Error('設定驗證未通過：'+e.issues.slice(0,3).map(i=>`${i.path.join('.')||'設定'} ${i.message}`).join('；'));
        throw new Error(e instanceof Error && /^(?:回測|連線|CA|圖表|API|Codex|本機|用法|未知指令|委託 ID|實盤|每種|交易模式|須先|目前模式|請先|尚未|上一輪|程式正在|無法|本輪|自動|設定|停止)/.test(e.message)
        ? e.message : '操作未完成，請核對本機狀態與設定'); }
    });
  };
  handle('trader:state',() => ({status:service?.engine.status(new Date()) ?? '',logs:service?.store.logs() ?? [],
    settings:JSON.stringify(service?.engine.settings ?? SettingsSchema.parse({mode}),null,2),
    connected:connected(),error:initialError||(mode==='live'?service?.engine.dataIssue??'':''),backtest:backtest.text(),backtest_running:backtest.progress.running,
    backtest_report:!!backtest.report,experience:service?experienceStatus(service.store,service.engine.settings,new Date().toISOString()):'',codex_login:codexLogin.status.message,
    codex_auth:{...codexLogin.status},
    runtime:service?{mode,auto:service.engine.settings.auto_execute,paused:service.engine.pausedEntries,killed:service.engine.killed,
      blocked:service.engine.entryBlocked,connected:connected(),session:service.calendar.inSession(new Date()),account:service.engine.account??null,
      plan:service.engine.plan??null,protections:service.store.protections(),orders:service.store.orders(true),quotes:[...service.engine.quotes.values()],
      watch:service.engine.watch,next_strategy_at:service.nextStrategyAt(),analyzing:service.analyzing,scanning:service.scanning,
      analysis_status:service.analysisStatus,last_monitor_at:service.lastMonitorAt,
      features:service.engine.watchFeatures,metadata:service.engine.metadata,
      decisions:[...service.engine.decisionStates].map(([symbol,state])=>({symbol,...state}))}:null,
    backtest_progress:backtest.progress,backtest_result:backtest.report?{...backtest.report,fills:backtest.report.fills.slice(-80),
      orders:backtest.report.orders.slice(-80),strategy_log:backtest.report.strategy_log.slice(-25),logs:backtest.report.logs.slice(-50)}:null,
    backtest_history:backtest.history,backtest_comparisons:backtest.comparisons,
    connection:{status:nativeConnection.status,remembered,encrypted:secureAvailable(),busy:connectionBusy||operations.busy,has_ca:nativeConnection.hasCa},
    live:smoke&&mode==='live'?{authorized:false,ready:false,account:'隔離測試帳戶',issues:['測試資料：不會啟用實盤交易']}
      :service?.liveReadiness()??{authorized:false,ready:false,account:'尚未連接帳戶',issues:['請先連接 Shioaji']},
    analyst_events:[...(service?.analystEvents??[]).map(e=>({...e,context:'live' as const})),...backtest.analystEvents.map(e=>({...e,context:'replay' as const}))].sort((a,b)=>a.at.localeCompare(b.at)).slice(-80),
    replay:backtest.frame??null,replay_paused:backtest.clock.paused,replay_speed:backtest.clock.speed,
    replay_symbols:replaySymbols(),codex_models:codexModels()} satisfies DesktopState));
  handle('trader:command',async value => {
    if (typeof value !== 'string' || value.length > 2000 || !service) throw new Error('未知指令或程式尚未啟動');
    if (value.trim() === 'exit') { await exit(); return '結束程式'; }
    const command=value.trim();
    if(/^(?:stop|lock-live)$/.test(command))liveActionEpoch++;
    else if(operations.busy&&!/^(?:status|help|cancel-analysis)$/.test(command))throw new Error('目前連線、模式切換或實盤確認仍在進行');
    if(!smoke&&mode==='paper'&&/^(?:decide|review|watch|start-auto|auto\s+on)(?:\s|$)/.test(value.trim()))
      throw new Error('模擬策略請從主視窗開始歷史模擬，AI 只會使用模擬時間以前的資料');
    if(mode==='live'&&/^(?:start-auto|auto\s+on)$/.test(command))return enableLive(true);
    if(mode==='live'&&/^(?:cancel(?:\s|$)|cancel-all$)/.test(command)&&!service.liveCancelAuthorized)
      return enableLive(false,selected=>selected.command(command));
    return service.command(command);
  });
  handle('trader:settings',value => operations.run(async () => {
    if (typeof value !== 'string' || value.length > 20000 || !service) throw new Error('設定內容不合法');
    const settings = SettingsSchema.parse(JSON.parse(value));
    if(settings.mode!==mode)throw new Error('設定中的模式需使用「切換並重新連線」變更');
    if(settings.base_url!==service.engine.settings.base_url)throw new Error('連線由程式自動管理，無需設定服務網址');
    if(settings.stock_account_index!==service.engine.settings.stock_account_index){
      loopbackOrigin(settings.base_url);
      if(backtest.progress.running)throw new Error('回測仍在進行，請先停止再變更帳戶');
      if(service.store.orders(true).length||service.engine.account?.orders.some(active))throw new Error('目前仍有未完成委託，不能變更連線設定');
      await connect(mode,settings);return initialError||'設定已儲存並重新連線；新連線設定使用獨立資料庫，自動執行已關閉，請先核對帳戶';
    }
    await service.saveSettings(settings);
    commonSettings.save(service.engine.settings);
    if (settings.keep_awake && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!settings.keep_awake && blocker !== undefined) {powerSaveBlocker.stop(blocker);blocker=undefined;}
    return '設定已儲存 · 模擬與實盤共用';
  }));
  handle('trader:configure',value => operations.run(async () => {
    const next = z.enum(['paper','live']).parse(value);
    if(next===mode)return '目前已是'+(next==='live'?'實盤':'模擬')+'模式';
    if(backtest.progress.running||connectionBusy)throw new Error('目前仍有模擬或連線在進行，請先停止再切換模式');
    if (service?.store.orders(true).length||service?.engine.account?.orders.some(active)) throw new Error('目前模式仍有未完成委託，請先核對並處理');
    await connect(next); return initialError || '已切換到 ' + next;
  }));
  handle('trader:authorize',() => enableLive(true));
  handle('trader:hide',() => { if (tray) window?.hide(); else window?.minimize(); });
  handle('trader:backtest',value=>operations.run(async()=>{
    if(connectionBusy)throw new Error('目前連線或模式切換仍在進行');
    if(!service)throw new Error('回測需要有效的本機設定');
    const request=BacktestRequestSchema.parse(value);let csv:string|undefined;
    if(!smoke&&(!nativeConnection.connected||request.source!=='shioaji'||!['codex','rules'].includes(request.strategy)))
      throw new Error('回測需要連接 Shioaji 真實行情；請先完成 API 設定');
    if(!smoke&&request.strategy==='codex'&&!await codexLogin.check())throw new CodexError('Codex 尚未登入，請先按登入；快速程式模擬可直接執行');
    if(request.source==='csv'){
      const result=await dialog.showOpenDialog(window!,{title:'匯入歷史行情 CSV（含至少 20 個交易日暖機資料）',properties:['openFile'],filters:[{name:'CSV',extensions:['csv']}]});
      if(result.canceled)return '已取消匯入';const path=result.filePaths[0]!;
      if(statSync(path).size>80000000)throw new Error('回測 CSV 超過 80 MB');csv=readFileSync(path,'utf8');
    }
    return backtest.start(request,service.engine.settings,csv);
  }));
  handle('trader:backtest-cancel',()=>backtest.cancel());
  handle('trader:backtest-select',value=>{if(typeof value!=='string')throw new Error('回測報表識別不合法');return backtest.select(value);});
  handle('trader:file',async value=>{
    z.literal('ca').parse(value);
    const result=await dialog.showOpenDialog(window!,{title:'選取 CA 憑證',properties:['openFile'],filters:[{name:'CA 憑證',extensions:['pfx','p12']}]});
    return result.canceled?'':result.filePaths[0]??'';
  });
  const apiConnect=(input:unknown):Promise<string>=>operations.run(async()=>{
    if(connectionBusy)throw new Error('連線仍在進行');if(!service)throw new Error('連線設定尚未載入');
    if(backtest.progress.running||service.store.orders(true).length||service.engine.account?.orders.some(active))throw new Error('目前仍有回測或未完成委託，不能變更 API 連線');
    connectionBusy=true;
    try{const settings=SettingsSchema.parse({...service.engine.settings,auto_execute:false});
      const validated=ConnectionInputSchema.parse(input);await service.close();service=undefined;
      await nativeConnection.close();await nativeConnection.start(validated);
      await vault.save(validated);remembered=validated.remember;await connect(mode,settings);
      return initialError||'Shioaji 已連線，可開始模擬或 Codex 分析';
    }finally{connectionBusy=false;if(!service)await connect(mode);}
  });
  handle('trader:connect-api',apiConnect);
  handle('trader:connect-saved',async()=>{const input=await vault.read();if(!input)throw new Error('尚未記住 API 金鑰');return apiConnect(input);});
  handle('trader:forget-credentials',()=>operations.run(async()=>{await vault.clear();remembered=false;return '已移除記住的金鑰與憑證設定';}));
  handle('trader:chart',async value=>{
    const request=ChartRequestSchema.parse(value);if(request.source==='replay'||smoke)return backtest.chart({...request,source:'replay'});
    if(!nativeConnection.connected&&!smoke)throw new Error('圖表需要先連接 Shioaji 真實行情');
    if(chartBusy)throw new Error('圖表資料正在載入');chartBusy=true;
    try{return await liveChart(request,service!.engine.settings,join(dataRoot,'backtests','cache'),chartAbort.signal);}
    finally{chartBusy=false;}
  });
  handle('trader:replay-control',value=>backtest.control(z.enum(['pause','resume','step']).parse(value)));
  handle('trader:replay-speed',value=>backtest.speed(z.number().finite().min(0).max(100000).parse(value)));
  handle('trader:export-market',async()=>{
    if(backtest.progress.running)throw new Error('回測完成後才能匯出整段原始行情');
    const dataset=await backtest.marketData(),result=await dialog.showSaveDialog(window!,{title:'匯出完整歷史行情',defaultPath:'Shioaji-history.csv',filters:[{name:'CSV',extensions:['csv']}]});
    if(result.canceled||!result.filePath)return '已取消匯出';
    const columns=['symbol','at','open','high','low','close','volume_shares'] as const;
    writeFileSync(result.filePath,'\uFEFF'+columns.join(',')+'\r\n'+dataset.points.map(p=>columns.map(k=>String(p[k])).join(',')).join('\r\n'),{mode:0o600});return '完整歷史行情已匯出';
  });
  handle('trader:codex-login',value=>{
    if(smoke)throw new Error('Codex 登入不在測試流程執行');
    return codexLogin.start(value==='device');
  });
  handle('trader:codex-open',()=>{if(smoke)throw new Error('Codex 登入不在測試流程執行');return codexLogin.reopen();});
  handle('trader:codex-test',()=>{
    if(smoke||!service)throw new Error('Codex 連線測試不在隔離流程執行');
    return codexLogin.test(service.engine.settings);
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
function connected():boolean{return smoke?!!service?.engine.connected:nativeConnection.connected;}
async function enableLive(startAutomation:boolean,afterAuthorization?:(selected:TradingService)=>Promise<string>):Promise<string>{
  return operations.run(async()=>{
    const selected=service,epoch=liveActionEpoch;
    if(!selected||mode!=='live'||!nativeConnection.connected)throw new Error('請先連接實盤帳戶');
    if(startAutomation&&!await codexLogin.check())throw new CodexError('Codex 尚未登入，請先按登入');
    const live=await selected.prepareLive(),s=selected.engine.settings;
    if(!(startAutomation?selected.liveAuthorized:selected.liveCancelAuthorized)){
      const percent=(v:string):string=>(Number(v)*100).toLocaleString('zh-TW')+'%';
      const answer=await dialog.showMessageBox(window!,{type:'warning',buttons:['取消',startAutomation?'確認並啟動實盤':'確認授權撤單'],defaultId:0,cancelId:0,
        message:startAutomation?'啟動本次現股自動交易':'授權本次處理券商掛單',
        detail:`帳戶 ${live.account}\n可用現金與交割、CA 及券商回報已核對。\n現金保留 ${percent(s.min_cash_fraction)}；單筆 ${percent(s.max_order_fraction)}；單檔 ${percent(s.max_symbol_fraction)}；日損失 ${percent(s.daily_loss_fraction)} 停止新買進。\n${startAutomation?'確認後依有效 Codex 策略執行現股限價單。':'只處理本程式的券商掛單，自動交易保持關閉。'}今日新增股數不當沖。授權僅本次有效；停損需本機持續運作且不保證成交。`});
      if(answer.response!==1)return '已取消實盤授權';
      if(quitting||epoch!==liveActionEpoch||selected!==service)throw new Error('實盤啟動已停止');
      await selected.activateLive(startAutomation?'trade':'cancel');
    }
    if(quitting||epoch!==liveActionEpoch||selected!==service){selected.liveSession.revoke();throw new Error('實盤啟動已停止');}
    return afterAuthorization?afterAuthorization(selected):selected.command('start-auto');
  });
}
function secureAvailable():boolean { return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'); }
function replaySymbols():{symbol:string;name:string}[]{
  const symbols=new Map<string,string>();for(const w of backtest.frame?.watch.entries??[])symbols.set(w.symbol,w.name);
  for(const row of backtest.report?.strategy_log??[])for(const symbol of row.selected)if(!symbols.has(symbol))symbols.set(symbol,symbol);
  for(const p of backtest.report?.positions??[])if(!symbols.has(p.symbol))symbols.set(p.symbol,p.symbol);
  return [...symbols].map(([symbol,name])=>({symbol,name}));
}
function codexModels():string[]{
  try {const raw=JSON.parse(readFileSync(join(dataRoot,'codex-login','models_cache.json'),'utf8')) as {models?:{slug?:string}[]};
    return (raw.models??[]).flatMap(m=>typeof m.slug==='string'?[m.slug]:[]).slice(0,50);
  }catch{return [];}
}
async function smokeTest(): Promise<void> {
  if (!window || !service || initialError || mode !== 'demo') throw new Error('桌面測試未啟動');
  if (process.platform === 'win32' && !tray) throw new Error('Windows 系統匣未啟動');
  const version = await promisify(execFile)(bundledCodexPath(),['--version'],{timeout:20000,windowsHide:true});
  if (!version.stdout.includes('codex')) throw new Error('Codex 打包執行檔無法啟動');
  const isolatedAuth=join(dataRoot,'smoke-auth');prepareCodexProfile(isolatedAuth,join(dataRoot,'empty-auth'));
  const isolatedEnv=codexEnvironment(process.env,isolatedAuth);delete isolatedEnv.OPENAI_API_KEY;delete isolatedEnv.CODEX_API_KEY;
  let signedOut=false;
  try{await promisify(execFile)(bundledCodexPath(),['-c','cli_auth_credentials_store="file"','login','status'],{env:isolatedEnv,timeout:20000,windowsHide:true});}
  catch(error){const result=error as {code?:number;stdout?:string;stderr?:string};signedOut=result.code===1&&/not logged in/i.test((result.stdout??'')+(result.stderr??''));}
  if(!signedOut)throw new Error('打包後 Codex 隔離登入狀態未通過');
  if(!process.argv.includes('--ui-only')||app.isPackaged){const binary=await brokerPath();
    const native=await promisify(execFile)(binary,['--version'],{timeout:20000,windowsHide:true,env:{...process.env,PATH:''}});
    if(!native.stdout.includes('1.7.7'))throw new Error('內建 Shioaji 版本未通過');
    const help=await promisify(execFile)(binary,['server','start','--help'],{timeout:20000,windowsHide:true});
    if(!help.stdout.includes('--no-open'))throw new Error('內建 Shioaji 啟動方式未通過');
  }
  if (!window.webContents.isLoading()) await verifyRenderer();
  else await new Promise<void>((resolve,reject) => {
    window!.webContents.once('did-finish-load',() => { void verifyRenderer().then(resolve,reject); });
    window!.webContents.once('did-fail-load',() => reject(new Error('視窗未載入')));
  });
  await service.command('auto on'); await service.command('pause');
  if (!service.engine.pausedEntries || !service.engine.settings.auto_execute) throw new Error('指令測試失敗');
  await service.command('resume');
  const virtual=new Date('2026-10-08T10:00:00+08:00'),snapshot=await service.engine.snapshot(virtual);
  await service.engine.activate(demoAnalysis(snapshot,service.engine.settings,virtual),snapshot,virtual);
  for(let n=0;n<4;n++)await service.engine.tick(new Date(virtual.getTime()+n*3000));
  if(!service.engine.watch.entries.length||!service.store.orders().some(o=>o.filled>0))throw new Error('打包後動態觀測與條件執行未通過');
  backtest.start({start:'2026-10-01',end:'2026-10-08',source:'sample',strategy:'demo',initial_cash:'100000',strategy_schedule:'interval',comparison_intervals:[120,180]},service.engine.settings);
  await backtest.wait();
  if(!backtest.report||backtest.report.status!=='COMPLETED'||!backtest.report.metrics.filled_orders)throw new Error('打包後歷史模擬未通過');
  if(backtest.comparisons.length!==2)throw new Error('打包後排程比較未通過');
  await verifyRenderer();
  const expectedStock=await window.webContents.executeJavaScript(`(()=>{const buttons=[...document.querySelectorAll('#overview-watch td button')];buttons[1]?.click();buttons[2]?.click();return buttons[2]?.textContent;})()`);
  await new Promise(resolve=>setTimeout(resolve,1800));
  const selected=await window.webContents.executeJavaScript(`document.querySelector('#chart-name').textContent`);
  if(!expectedStock||!selected.includes(expectedStock))throw new Error('快速切換股票圖表未通過');
  await window.webContents.executeJavaScript(`document.querySelector('#chart-start').value='2020-03-02';document.querySelector('#chart-end').value='2020-03-03'`);
  await backtest.select(backtest.comparisons[0]!.id);await new Promise(resolve=>setTimeout(resolve,1500));
  const range=await window.webContents.executeJavaScript(`({start:document.querySelector('#chart-start').value,end:document.querySelector('#chart-end').value,schedule:document.querySelector('#schedule-strategy').textContent})`);
  if(range.start!==backtest.report.request.start||range.end!==backtest.report.request.end
    ||range.schedule!==backtest.report.request.decision_interval_minutes+' 分鐘'||backtest.progress.total_runs!==undefined)throw new Error('切換歷史報表日期與排程未通過');
  window.webContents.debugger.attach('1.3');
  const artifacts=process.env.TRADER_SMOKE_OUTPUT??join(process.cwd(),'release');mkdirSync(artifacts,{recursive:true});
  for(const [width,height] of [[1600,960],[1366,768],[1920,1080]] as const){
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await window.webContents.executeJavaScript(`(()=>{document.querySelector('#bt-start').value='2026-10-01';document.querySelector('#bt-end').value='2026-10-08';document.querySelector('#chart-symbol').value='9001';document.querySelector('#chart-start').value='2026-10-01';document.querySelector('#chart-end').value='2026-10-08';document.querySelector('#chart-form').requestSubmit();})()`);
    await new Promise(resolve=>setTimeout(resolve,1800));
    await verifyLayout('paper');
    await capture(`SYNTHETIC-ui-paper-${width}.png`,width,height);
  }
  await service.command('auto off');mode='live';
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1600,height:960,deviceScaleFactor:1,mobile:false});
  await new Promise(resolve=>setTimeout(resolve,1600));await verifyLayout('live');
  const liveUi=await window.webContents.executeJavaScript(`(async()=>({ack:!!document.querySelector('#ack'),button:document.querySelector('#start-live').textContent,
    authorized:(await window.trader.state()).live.authorized,rejected:await window.trader.authorizeLive().then(()=>false,()=>true)}))()`);
  if(liveUi.ack||!liveUi.button.includes('啟動實盤')||liveUi.authorized||!liveUi.rejected)throw new Error('單次實盤授權介面或測試隔離未通過');
  await capture('SYNTHETIC-ui-live.png',1600,960);mode='demo';
  await new Promise(resolve=>setTimeout(resolve,1200));
  await window.webContents.executeJavaScript(`document.querySelector('#open-settings').click()`);
  const savedModel=service.engine.settings.codex_model;
  await window.webContents.executeJavaScript(`(()=>{document.querySelector('#s-order-limit').value='0.06';document.querySelector('#s-order-limit').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#codex-model-control').value='smoke-model';document.querySelector('#codex-model-control').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#codex-save').click();})()`);
  await new Promise(resolve=>setTimeout(resolve,1500));
  const unsaved=await window.webContents.executeJavaScript(`({limit:document.querySelector('#s-order-limit').value,state:document.querySelector('#settings-state').textContent})`);
  if(unsaved.limit!=='0.06'||unsaved.state!=='尚未儲存'||service.engine.settings.codex_model!=='smoke-model')throw new Error('Codex 儲存覆蓋未儲存帳戶設定');
  await window.webContents.executeJavaScript(`document.querySelector('#settings-form').requestSubmit()`);await new Promise(resolve=>setTimeout(resolve,1400));
  if(service.engine.settings.codex_model!=='smoke-model'||service.engine.settings.max_order_fraction!=='0.06')throw new Error('帳戶設定覆蓋 Codex 修改');
  await service.saveSettings({...service.engine.settings,codex_model:savedModel,max_order_fraction:'0.10'});await new Promise(resolve=>setTimeout(resolve,1200));
  const credentials=await window.webContents.executeJavaScript(`({visible:document.querySelector('#settings-dialog').open,
    key:document.querySelector('#api-key').type,secret:document.querySelector('#secret-key').type,ca:!!document.querySelector('#choose-ca'),
    removed:!!document.querySelector('#cli-path,#connection-url,#choose-cli')})`);
  if(!credentials.visible||credentials.key!=='password'||credentials.secret!=='password'||!credentials.ca||credentials.removed)throw new Error('帳戶設定未通過');
  await capture('SYNTHETIC-ui-connection.png',1600,960);
  await window.webContents.executeJavaScript(`document.querySelector('#settings-dialog').close();document.querySelector('[data-dialog="history-dialog"]').click()`);
  await capture('SYNTHETIC-ui-history.png',1600,960);
  await window.webContents.executeJavaScript(`document.querySelector('#history-dialog').close()`);
  await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');window.webContents.debugger.detach();
  async function capture(name:string,width:number,height:number):Promise<void>{
    const shot=await window!.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:0,y:0,width,height,scale:1}}) as {data:string};
    writeFileSync(join(artifacts,name),Buffer.from(shot.data,'base64'));
  }
  async function verifyLayout(expected:string):Promise<void>{
    const result=await window!.webContents.executeJavaScript(`(()=>{
      const visible=selector=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight&&box.right<=innerWidth;};
      return {mode:document.body.dataset.workspace,watchRows:document.querySelectorAll('#overview-watch tbody tr').length,
        watchPrices:[...document.querySelectorAll('#overview-watch tbody tr td:nth-child(3)')].some(cell=>cell.textContent!=='—'),pnl:document.querySelector('#bt-pnl').textContent,
        panels:['.watch-panel','.positions-panel','.chart-panel','.codex-panel','.execution-panel'].every(visible),auth:['#codex-login','#codex-test','#codex-device'].every(visible),
        simulation:visible('.simulation-controls'),equity:visible('.equity-panel'),orders:visible('#orders'),
        pages:document.querySelectorAll('[data-page],[data-tab]').length,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,
        viewport:innerWidth,viewportHeight:innerHeight,times:document.querySelector('#s-times').value,
        settings:document.querySelector('#settings-dialog').open};})()`);
    if(result.mode!==expected||!result.panels||!result.auth||result.pages||result.width>result.viewport||result.height>result.viewportHeight||result.settings
      ||expected==='paper'&&(!result.simulation||!result.equity||result.watchRows<5||!result.watchPrices||result.pnl==='—')
      ||expected==='live'&&(!result.orders||result.simulation||result.equity))throw new Error('單一工作台版面未通過：'+JSON.stringify(result));
  }
  const before = window.isVisible(); window.hide(); if (window.isVisible()) throw new Error('隱藏測試失敗');
  window.show(); if (before && !window.isVisible()) throw new Error('重開測試失敗');
  console.log('Electron single workspace at 1366/1600/1920, both modes, single live confirmation UI, rapid chart selection, report dates, independent settings, built-in Shioaji, credentials, replay and tray: PASS'); await exit();
}
async function verifyRenderer(): Promise<void> {
  const result = await window!.webContents.executeJavaScript(`(async () => ({ bridge: typeof window.trader?.state === 'function',
    node: typeof window.require, status: (await window.trader.state()).status,
    workspaces:document.querySelectorAll('.terminal-grid').length,codex:!!document.querySelector('.codex-panel'),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content }))()`);
  if (!result.bridge || result.node !== 'undefined' || !result.status || !result.csp || result.workspaces!==1||!result.codex) throw new Error('安全 IPC 或單一工作台未載入');
}
async function exit(): Promise<void> {
  if (quitting) return;
  const pending = service?.store.orders(true).length ?? 0;
  if (pending && !smoke) {
    const answer = await dialog.showMessageBox(window!,{type:'warning',buttons:['繼續監控','結束程式'],defaultId:0,cancelId:0,
      message:`仍有 ${pending} 筆未完成委託`,detail:'結束後本機智慧條件停止監控，券商掛單仍存在。可先用 cancel-all 核對撤單。'});
    if (answer.response !== 1) return;
  }
  quitting = true;liveActionEpoch++;chartAbort.abort();
  codexLogin?.close();await codexLogin?.wait();
  backtest?.cancel();await backtest?.wait();
  await service?.close(); service = undefined;await nativeConnection?.close();
  if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  tray?.destroy(); window?.destroy();
  if (smoke) rmSync(dataRoot,{recursive:true,force:true}); app.quit();
}
