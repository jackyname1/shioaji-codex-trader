import {buildIdentity} from '../core/build-identity.js';
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, powerSaveBlocker,
  safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync,readFileSync,writeFileSync,statSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TradingService } from '../core/service.js';
import { SettingsSchema,active,d, type Settings } from '../core/models.js';
import { demoAnalysis } from '../core/strategy.js';
import { Store } from '../core/store.js';
import { loopbackOrigin,ShioajiHttpBroker } from '../broker/http.js';
import { brokerIssue, BrokerError } from '../broker/health.js';
import type { DesktopState } from './shared.js';
import { bundledCodexPath, CodexError, codexEnvironment, prepareCodexProfile,compactAnalystEvent } from '../core/codex.js';
import {ReplayClock} from '../core/replay-clock.js';
import { BacktestController } from '../core/backtest-controller.js';
import {replayMinutesCsv} from '../core/backtest-data.js';
import { BacktestRequestSchema,fillsCsv } from '../core/backtest.js';
import { experienceStatus } from '../core/experience.js';
import { z } from 'zod';
import { CredentialVault,CredentialError,NativeConnection,connectionInput,type CredentialState } from './credentials.js';
import {actualOrdersBlock,reconnectBlocked,connectionView} from './connection-state.js';
import {activateWindow} from './window-activation.js';
import {mergeDiagnostics} from '../broker/diagnostics.js';
import {ConnectionSmoke} from './connection-smoke.js';
import {openWorkspace,workspaceFailure,WorkspaceProfileError,type WorkspaceDiagnostic} from './workspace-profile.js';
import { liveChart } from '../core/live-chart.js';
import { ChartRequestSchema } from '../core/chart.js';
import { bundledShioajiPath } from './broker-runtime.js';
import { DesktopOperations } from './operations.js';
import { DesktopSettings } from './settings.js';
import { CodexLogin } from './codex-login.js';
import { PaperBroker } from '../broker/paper.js';
import { spendableCash } from '../core/execution.js';

let window: BrowserWindow | undefined, tray: Tray | undefined, service: TradingService | undefined;
let trayTimer:NodeJS.Timeout|undefined,nativeStatusKey='';
let nativeOverlayClears=0;
let quitting = false, initialError = '', blocker: number | undefined;
let foregroundRequested=false;
const smoke = process.argv.includes('--smoke-test');
let smokeDeadline:NodeJS.Timeout|undefined;
let smokeChecksCompleted=false;
const smokeTrace:{stage:string;at:string}[]=[];
function smokeMark(stage:string,error=''):void{
  if(!smoke)return;
  smokeTrace.push({stage,at:new Date().toISOString()});
  const root=process.env.TRADER_SMOKE_OUTPUT??join(process.cwd(),'release');mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'SMOKE-RESULT.json'),JSON.stringify({version:app.getVersion(),packaged:app.isPackaged,
    status:stage==='PASSED'?'PASSED':stage==='FAILED'?'FAILED':'RUNNING',stage,error,trace:smokeTrace},null,2));
  console.log('GUI smoke stage: '+stage);
}
const argsMode = process.argv.find(a => a.startsWith('--mode='))?.slice(7);
let mode = SettingsSchema.shape.mode.parse(smoke?'demo':argsMode==='live'?'live':'paper');
let simulationScope:'realtime'|'replay'=smoke?'replay':'realtime';
const directory = dirname(fileURLToPath(import.meta.url));
let dataRoot = '';
let backtest:BacktestController;
let vault:CredentialVault,nativeConnection:NativeConnection;
let credentialState:CredentialState={remembered:false,state:'empty',message:'尚未保存登入設定'};
let connectionBusy=false,chartBusy=false;const chartAbort=new AbortController();
let loginStage='',smokeConnection=false;
let smokeMarket:ConstructorParameters<typeof TradingService>[2];
let smokeReadMarket:ConstructorParameters<typeof TradingService>[2];
const operations=new DesktopOperations();let liveActionEpoch=0;
const brokerPath=():Promise<string>=>bundledShioajiPath(app.isPackaged?join(process.resourcesPath,'shioaji'):join(directory,'../../../resources/shioaji'));
let commonSettings:DesktopSettings,codexLogin:CodexLogin;
let workspaceDiagnostic:WorkspaceDiagnostic|undefined;
let preferences:{last_mode:Settings['mode'];paper_scope?:'realtime'|'replay';connections:Partial<Record<Settings['mode'],{base_url:string;stock_account_index:number}>>}={last_mode:'paper',connections:{}};

// Match the executable's Windows identity across portable versions and extraction paths.
if(process.platform==='win32')app.setAppUserModelId('tw.shioaji.codex.trader');
if (!smoke&&!app.requestSingleInstanceLock()) app.quit();
else {
  const foreground=()=>{foregroundRequested=true;activateWindow(window);};
  app.on('second-instance',foreground);app.on('activate',foreground);
  app.on('window-all-closed',() => { /* tray continues */ });
  app.on('before-quit',event => { if (!quitting) { event.preventDefault(); void exit(); } });
  void app.whenReady().then(async () => {
    if(smoke){smokeMark('INITIALIZING');smokeDeadline=setTimeout(()=>{
      smokeMark('FAILED','GUI smoke internal deadline at '+smokeTrace.at(-1)?.stage);app.exit(1);
    },240000);smokeDeadline.unref();}
    dataRoot = smoke ? mkdtempSync(join(tmpdir(),'shioaji-ts-smoke-')) : join(app.getPath('userData'),'state');
    if(!smoke)try{const p=JSON.parse(readFileSync(join(dataRoot,'desktop-settings.json'),'utf8')) as typeof preferences;
      SettingsSchema.shape.mode.parse(p.last_mode);for(const c of Object.values(p.connections))if(c){loopbackOrigin(c.base_url);SettingsSchema.shape.stock_account_index.parse(c.stock_account_index);}
      preferences=p;if(!argsMode)mode='paper';simulationScope=p.paper_scope==='replay'?'replay':'realtime';
    }catch{/* New or malformed preferences start in paper mode. */}
    commonSettings=new DesktopSettings(dataRoot);
    try{commonSettings.migrate(preferences.last_mode,preferences.connections[preferences.last_mode]?.stock_account_index??0);}
    catch{/* A preference write must not prevent the login window; connect records its exact safe stage. */}
    const secure={isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),
      encryptString:(value:string)=>safeStorage.encryptString(value),decryptString:(value:Buffer)=>safeStorage.decryptString(value)};
    vault=new CredentialVault(join(dataRoot,'private'),secure);nativeConnection=new NativeConnection(join(dataRoot,'native-service'),brokerPath);
    const saved=await vault.read();credentialState=await vault.status();
    backtest=new BacktestController(join(dataRoot,'backtests'),state=>{if(window&&!window.isDestroyed())window.webContents.send('trader:replay-clock',state);});await backtest.restore();
    await connect(mode);
    codexLogin=new CodexLogin(join(dataRoot,'codex-login'),url=>shell.openExternal(url),async()=>{
      const selected=service;if(!selected||quitting||selected.engine.settings.codex_enabled)return;
      await selected.saveSettings({...selected.engine.settings,codex_enabled:true});
      if(selected===service)commonSettings.save(selected.engine.settings);
    },{settings:()=>service?.engine.settings??commonSettings.apply(SettingsSchema.parse({}),mode,nativeConnection.baseUrl)});
    if(smoke){codexLogin.status.state='signed_out';codexLogin.status.message='隔離測試：不會使用真實 Codex 登入';}
    createWindow(); createTray(); registerIpc();
    if(!smoke)void codexLogin.check();
    if(saved&&!smoke)try{await operations.run(()=>login(saved));}catch(error){initialError=desktopIssue(error);}
    if(quitting)return;
    if (service?.engine.settings.keep_awake) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (service?.engine.settings.start_minimized && tray && !smoke && nativeConnection.connected && !initialError && !foregroundRequested) window!.hide();
    if (smoke) await smokeTest();
  }).catch(error => {if(smoke){if(smokeDeadline)clearTimeout(smokeDeadline);smokeMark('FAILED',error instanceof Error?error.message:'GUI smoke failed');}
    console.error(smoke ? error : '桌面啟動失敗'); app.exit(1); });
}
async function connect(nextMode: Settings['mode'],override?:Settings,start=true): Promise<void> {
  const old=service;service=undefined;initialError='';mode=nextMode;
  workspaceDiagnostic={mode:mode==='live'?'live':'paper',stage:'closing',state:'loading',code:'',issue:''};
  try {
    if(old)await old.close();
    workspaceDiagnostic.stage='database';
    const opened=openWorkspace(dataRoot,mode,nativeConnection.baseUrl,commonSettings,override,smokeConnection?smokeMarket:undefined,!smoke&&mode==='live',smokeConnection?smokeReadMarket:undefined);
    service=opened.service;workspaceDiagnostic=opened.diagnostic;
    if(start&&((smoke&&!smokeConnection)||nativeConnection.connected))await service.start(!smoke);
    if(workspaceDiagnostic.state!=='read_only')workspaceDiagnostic.state=service.engine.connected?'ready':'loading';
    // Preferences must never prevent the already-authenticated broker's account reads.
    try {
      commonSettings.save(service.engine.settings);
      preferences.last_mode=mode;preferences.connections[mode]={base_url:nativeConnection.baseUrl,stock_account_index:service.engine.settings.stock_account_index};
      if(!smoke)writeFileSync(join(dataRoot,'desktop-settings.json'),JSON.stringify(preferences),{mode:0o600});
    }catch(error){const warning=workspaceFailure(mode,'preferences',error);
      workspaceDiagnostic=service.persistenceIssue?{...workspaceDiagnostic,issue:workspaceDiagnostic.issue+'；桌面偏好亦暫時無法保存'}:
        {...warning,state:service.engine.connected?'ready':'loading',issue:warning.issue+'；目前工作台仍可讀取 Shioaji，偏好設定稍後再保存'};}
    initialError=workspaceDiagnostic.issue;
  }
  catch(error) {
    workspaceDiagnostic=error instanceof WorkspaceProfileError?error.diagnostic:workspaceFailure(mode,workspaceDiagnostic?.stage??'database',error);
    initialError=mode==='demo'?'模擬程式啟動失敗':error instanceof BrokerError?error.message:workspaceDiagnostic.issue;
  }
}
function desktopIssue(error:unknown):string {
  if(error instanceof CredentialError)return error.message;
  if(error instanceof Error&&error.message==='這個資料庫已有執行中的程式')return '交易工作台資料庫仍由另一個程式使用，請從系統匣完全結束舊版後重試';
  return brokerIssue(error);
}
async function login(input:unknown,repairClock=false):Promise<string>{
  if(connectionBusy)throw new Error('連線仍在進行');
  if(backtest.progress.running)throw new Error('回測仍在執行，請先停止再重新連線');
  const saved=await vault.read(),validated=connectionInput(input,saved);
  const sameLogin=nativeConnection.hasLoginIdentity?nativeConnection.sameLogin(validated):!!saved&&saved.api_key===validated.api_key&&saved.secret_key===validated.secret_key;
  if(reconnectBlocked(mode,!!(service?.store.orders(true).length||service?.engine.account?.orders.some(active)),sameLogin))
    throw new Error('實盤仍有未完成委託，請先核對後再變更 API 金鑰；相同登入可重新連線核對');
  connectionBusy=true;initialError='';
  try{
    const settings=SettingsSchema.parse({...service?.engine.settings??commonSettings.apply(SettingsSchema.parse({mode}),mode,nativeConnection.baseUrl),auto_execute:false});
    loginStage='正在加密保存登入設定';
    try{await vault.save(validated);}finally{credentialState=await vault.status();}
    loginStage='正在準備交易工作台';await connect(mode,settings,false);
    if(!service)throw new BrokerError(initialError||'交易工作台尚未建立');
    loginStage='';await nativeConnection.start(validated,repairClock);
    loginStage='正在載入帳務與行情';await connect(mode,settings);
    if(!service?.engine.connected)throw new BrokerError(initialError||service?.engine.dataIssue||'交易工作台尚未完成連線');
    return validated.remember?'Shioaji 已連線，登入設定已保存':'Shioaji 已連線，本次設定未保存';
  }catch(error){if(!(error instanceof z.ZodError))initialError=desktopIssue(error);throw error;}
  finally{connectionBusy=false;loginStage='';}
}
function connectionStatus(){
  const view=connectionView((smoke&&!smokeConnection)||nativeConnection.connected,!!service?.engine.connected,
    connectionBusy||operations.busy,loginStage||nativeConnection.status,initialError||(!nativeConnection.connected&&nativeConnection.phase==='failed'?nativeConnection.status:''));
  return service?.persistenceIssue&&view.workspace_ready&&!connectionBusy?{...view,phase:'read_only',status:'Shioaji 已連線 · 帳務可讀，本機紀錄待修復'}:view;
}
function createWindow(): void {
  window = new BrowserWindow({width:1600,height:960,minWidth:1100,minHeight:680,icon:join(directory,process.platform==='win32'?'assets/app.ico':'assets/app.png'),title:'Shioaji Codex Trader',
    backgroundColor:'#0c1016',show:false,webPreferences:{preload:join(directory,'preload.cjs'),nodeIntegration:false,
      contextIsolation:true,sandbox:true,webSecurity:true}});
  window.setMenuBarVisibility(false);
  if(smoke&&process.platform==='win32'){
    const clearOverlay=window.setOverlayIcon.bind(window);
    window.setOverlayIcon=(image,description)=>{if(image!==null)throw new Error('工作列不得疊加第二個圖示');nativeOverlayClears++;clearOverlay(image,description);};
  }
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.once('ready-to-show',() => window?.show());
  window.on('close',event => { if (!quitting && tray) { event.preventDefault(); window?.hide(); } });
  window.on('minimize',() => { if (tray) window?.hide(); });
  void window.loadFile(join(directory,'index.html'));
}
function trayIcon(state='ready'): Electron.NativeImage { return nativeImage.createFromPath(join(directory,`assets/tray-${state}.png`)).resize({width:20,height:20}); }
function updateNativeStatus():void {
  if(!tray)return;
  const engine=service?.engine,replay=mode!=='live'&&simulationScope==='replay';
  const stopped=!!engine?.killed,paused=!!engine?.pausedEntries;
  const state=replay?(backtest.progress.running?(backtest.clock.paused?'paused':'active'):'ready')
    :!engine?.connected?'offline':service?.persistenceIssue||stopped||paused?'paused':engine.settings.auto_execute?'active':'ready';
  const workspace=mode==='live'?'正式交易':replay?'歷史回放':'即時模擬';
  const activity=replay?(backtest.progress.running?(backtest.clock.paused?'已暫停':'回放中'):'待命')
    :!engine?.connected?'等待連線':service?.persistenceIssue?'帳務可讀 · 本機紀錄待修復':stopped?'委託已停止':paused?'暫停新增買進':service?.sizing?'Codex 確認數量':service?.analyzing?'Codex 更新條件':engine.settings.auto_execute?'自動監測中':'已連線 · 待命';
  const key=`${workspace}:${state}:${activity}`;if(key===nativeStatusKey)return;nativeStatusKey=key;
  const icon=trayIcon(state);tray.setImage(icon);tray.setToolTip(`Shioaji Codex Trader｜${workspace}｜${activity}`);
  // An entire tray tile as an overlay looks like two broken/stacked taskbar icons.
  // The taskbar keeps the base ICO; native state remains visible in the tray and its menu.
  if(process.platform==='win32')window?.setOverlayIcon(null,'');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:`${workspace} · ${activity}`,enabled:false},{type:'separator'},
    {label:'開啟交易工作台',click:()=>{foregroundRequested=true;activateWindow(window);}},
    {label:paused?'恢復新增買進':'暫停新增買進',enabled:!replay&&!stopped,click:()=>void service?.command(paused?'resume':'pause').catch(()=>undefined)},
    {label:'停止全部新委託',enabled:!replay,click:()=>{liveActionEpoch++;void service?.command('stop').catch(()=>undefined);}},
    {type:'separator'},{label:'結束程式',click:()=>void exit()},
  ]));
}
function createTray(): void {
  try {
    tray = new Tray(trayIcon());updateNativeStatus();trayTimer=setInterval(updateNativeStatus,1000);
    tray.on('click',() => { foregroundRequested=true;activateWindow(window); });
    tray.on('double-click',() => { foregroundRequested=true;activateWindow(window); });
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
    settings:JSON.stringify(service?.engine.settings ?? commonSettings.apply(SettingsSchema.parse({mode}),mode,nativeConnection.baseUrl),null,2),
    connected:connected(),workspace_mode:mode==='live'?'live':'paper',error:initialError||service?.engine.dataIssue||'',backtest:backtest.text(),backtest_running:backtest.progress.running,
    backtest_report:!!backtest.report,experience:service?experienceStatus(service.store,service.engine.settings,new Date().toISOString()):'',codex_login:codexLogin.status.message,
    codex_auth:{...codexLogin.status},broker_diagnostics:diagnosticSnapshot(),
    runtime:service?{mode,auto:service.engine.settings.auto_execute,paused:service.engine.pausedEntries,killed:service.engine.killed,
      blocked:service.engine.entryBlocked,connected:connected(),session:service.calendar.inSession(new Date()),account:service.engine.account??null,
      plan:service.engine.plan??null,protections:service.store.protections(),entry_tracks:service.store.entryTracks(),orders:service.store.orders(true),quotes:[...service.engine.quotes.values()],
      watch:service.engine.watch,next_strategy_at:service.nextStrategyAt(),analyzing:service.analyzing,scanning:service.scanning,
      analysis_status:service.analysisStatus,last_monitor_at:service.lastMonitorAt,
      sizing:service.sizing,execution_queue:[...service.engine.pendingExecutions.values()].map(t=>({symbol:t.order.symbol,action:t.order.action,state:t.state,trigger:t.trigger})),
      fills:service.broker instanceof PaperBroker?service.broker.fills(-80):[],
      features:service.engine.watchFeatures,metadata:service.engine.metadata,
      decisions:[...service.engine.decisionStates].map(([symbol,state])=>({symbol,...state}))}:null,
    backtest_progress:backtest.progress,backtest_result:backtest.report?{...backtest.report,analyst_events:undefined,fills:backtest.report.fills.slice(-80),
      orders:backtest.report.orders.slice(-80),strategy_log:backtest.report.strategy_log.slice(-25),logs:backtest.report.logs.slice(-50),
      workflow:backtest.report.workflow?.slice(-400),failures:backtest.report.failures?.slice(-20),
      timeline:backtest.report.timeline?.filter((_,index,rows)=>index%Math.max(1,Math.ceil(rows.length/1500))===0||index===rows.length-1)}:null,
    backtest_history:backtest.history,backtest_comparisons:backtest.comparisons,
    connection:{...connectionStatus(),remembered:credentialState.remembered,credential_state:credentialState.state,
      credential_message:credentialState.message,encrypted:secureAvailable(),busy:connectionBusy||operations.busy,has_ca:nativeConnection.hasCa},
    live:smoke&&mode==='live'?{authorized:false,ready:false,account:'隔離測試帳戶',issues:['測試資料：不會啟用實盤交易']}
      :service?.liveReadiness()??{authorized:false,ready:false,account:'尚未連接帳戶',issues:['請先連接 Shioaji']},
    analyst_events:[...(service?.analystEvents??[]).map(e=>({...compactAnalystEvent(e),context:'live' as const})),...backtest.analystEvents.slice(-200).map(e=>({...compactAnalystEvent(e),context:'replay' as const}))].sort((a,b)=>a.at.localeCompare(b.at)).slice(-400),
    replay:backtest.frame??null,replay_paused:backtest.clock.paused,replay_speed:backtest.clock.speed,replay_clock:backtest.clock.snapshot(),
    replay_symbols:replaySymbols(),codex_models:codexModels(),simulation_scope:simulationScope,
    codex_selection:codexLogin.status.model?{model:codexLogin.status.model,reasoning:codexLogin.status.reasoning??'default'}:null} satisfies DesktopState));
  handle('trader:command',async value => {
    if (typeof value !== 'string' || value.length > 2000 || !service) throw new Error('未知指令或程式尚未啟動');
    if (value.trim() === 'exit') { await exit(); return '結束程式'; }
    const command=value.trim();
    if(/^(?:stop|lock-live)$/.test(command))liveActionEpoch++;
    else if(operations.busy&&!/^(?:status|help|cancel-analysis)$/.test(command))throw new Error('目前連線、模式切換或實盤確認仍在進行');
    if(!smoke&&mode==='paper'&&simulationScope==='replay'&&/^(?:decide|review|watch|start-auto|auto\s+on)(?:\s|$)/.test(value.trim()))
      throw new Error('模擬策略請從主視窗開始歷史模擬，AI 只會使用模擬時間以前的資料');
    if(mode==='live'&&/^(?:start-auto|auto\s+on)$/.test(command))return enableLive(true);
    if(mode==='live'&&/^(?:cancel(?:\s|$)|cancel-all$)/.test(command)&&!service.liveCancelAuthorized)
      return enableLive(false,selected=>selected.command(command));
    return service.command(command);
  });
  handle('trader:export-diagnostics',async()=>{
    const target=await dialog.showSaveDialog(window!,{title:'匯出連線診斷（不含帳號、金鑰及帳務內容）',defaultPath:'Shioaji-connection-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});
    if(target.canceled||!target.filePath)return '已取消匯出';
    writeFileSync(target.filePath,JSON.stringify({version:app.getVersion(),created_at:new Date().toISOString(),diagnostics:diagnosticSnapshot()},null,2),{mode:0o600});
    return '連線診斷已匯出，不含帳號、金鑰及帳務內容';
  });
  handle('trader:retry-workspace',()=>operations.run(async()=>{
    if(connectionBusy||backtest.progress.running)throw new BrokerError('目前仍有連線或模擬在進行，請稍後重試');
    // Recovery reopens the original journal and resets authority. It never changes
    // credentials, launches another login, or resumes the previous auto session.
    liveActionEpoch++;
    const settings=SettingsSchema.parse({...service?.engine.settings??commonSettings.apply(SettingsSchema.parse({mode}),mode,nativeConnection.baseUrl),auto_execute:false});
    await connect(mode,settings);
    if(!service||service.persistenceIssue||!service.engine.connected)throw new BrokerError(initialError||'本機紀錄仍待恢復，請查看連線診斷');
    return initialError||'本機紀錄已恢復，已重新讀取帳務與委託；自動交易尚未開始';
  }));
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
    if(!smoke)void codexLogin.check();
    if (settings.keep_awake && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!settings.keep_awake && blocker !== undefined) {powerSaveBlocker.stop(blocker);blocker=undefined;}
    return '設定已儲存 · 模擬與實盤共用';
  }));
  handle('trader:configure',value => operations.run(async () => {
    const next = z.enum(['paper','live']).parse(value);
    if(next===mode)return '目前已是'+(next==='live'?'實盤':'模擬')+'模式';
    if(backtest.progress.running||connectionBusy)throw new Error('目前仍有模擬或連線在進行，請先停止再切換模式');
    if (actualOrdersBlock(mode,!!(service?.store.orders(true).length||service?.engine.account?.orders.some(active)))) throw new Error('實盤仍有未完成委託，請先核對並處理');
    await connect(next); return initialError || '已切換到 ' + next;
  }));
  handle('trader:authorize',() => enableLive(true));
  handle('trader:simulation-scope',value=>operations.run(async()=>{
    const scope=z.enum(['realtime','replay']).parse(value);
    if(mode==='live')throw new Error('請先切換至模擬模式');
    if(scope==='realtime'&&backtest.progress.running)throw new Error('回測仍在執行，請先停止再切換即時模擬');
    if(scope==='replay'&&service?.engine.settings.auto_execute)await service.command('auto off');
    simulationScope=scope;preferences.paper_scope=scope;
    if(!smoke)writeFileSync(join(dataRoot,'desktop-settings.json'),JSON.stringify(preferences),{mode:0o600});
    return scope==='realtime'?'即時模擬：真實行情、虛擬資金，與正式交易共用流程':'歷史回放：全部步驟依虛擬時間執行';
  }));
  handle('trader:saved-connection',()=>vault.read().then(saved=>saved??null));
  const analystHistory=(value:unknown)=>{
    const scope=z.enum(['runtime','replay']).parse(value);
    if(scope==='runtime')return service?.store.analystEvents(0)??[];
    const cutoff=backtest.progress.running?backtest.frame?.at:backtest.report?.asof;
    return backtest.analystEvents.filter(e=>!!cutoff&&Date.parse(e.asof)<=Date.parse(cutoff));
  };
  handle('trader:analyst-history',analystHistory);
  handle('trader:analyst-detail',value=>{
    const request=z.strictObject({scope:z.enum(['runtime','replay']),id:z.string().min(1).max(250)}).parse(value);
    if(request.scope==='runtime')return service?.store.analystEvent(request.id)?.details??null;
    const cutoff=backtest.progress.running?backtest.frame?.at:backtest.report?.asof;
    const event=backtest.analystEvents.find(e=>e.id===request.id&&!!cutoff&&Date.parse(e.asof)<=Date.parse(cutoff));
    return event?.details??null;
  });
  handle('trader:analyst-export',async value=>{
    const events=analystHistory(value);if(!events.length)throw new Error('尚未產生 Codex 執行紀錄');
    const target=await dialog.showSaveDialog({title:'匯出完整 Codex 紀錄',defaultPath:'Codex-execution-history.json',filters:[{name:'JSON',extensions:['json']}]});
    if(target.canceled||!target.filePath)return '已取消匯出';
    writeFileSync(target.filePath,JSON.stringify({version:app.getVersion(),build:buildIdentity(),scope:value,events},null,2),{mode:0o600});return '完整 Codex 紀錄已匯出';
  });
  handle('trader:hide',() => { if (tray) window?.hide(); else window?.minimize(); });
  handle('trader:backtest',value=>operations.run(async()=>{
    if(connectionBusy)throw new Error('目前連線或模式切換仍在進行');
    if(!service)throw new Error('回測需要有效的本機設定');
    const request=BacktestRequestSchema.parse(value);let csv:string|undefined;
    if(!smoke&&(!nativeConnection.connected||request.source!=='shioaji'||request.strategy!=='codex'))
      throw new Error('回測需要連接 Shioaji 真實行情；請先完成 API 設定');
    if(!smoke&&request.strategy==='codex'&&!await codexLogin.check())throw new CodexError('Codex 尚未登入，請先按登入');
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
  const apiConnect=(input:unknown):Promise<string>=>operations.run(()=>login(input));
  handle('trader:connect-api',apiConnect);
  handle('trader:repair-login-time',input=>operations.run(()=>{
    if(nativeConnection.connected||nativeConnection.diagnostics().startup?.code!=='SIGN_TIME')throw new BrokerError('目前沒有需要修復的登入簽章時間錯誤');
    return login(input,true);
  }));
  handle('trader:connect-saved',async()=>{const input=await vault.read();if(!input)throw new Error('尚未記住 API 金鑰');return apiConnect(input);});
  handle('trader:forget-credentials',()=>operations.run(async()=>{await vault.clear();credentialState=await vault.status();return '已移除記住的金鑰與憑證設定';}));
  handle('trader:chart',async value=>{
    const request=ChartRequestSchema.parse(value);if(request.source==='replay'||smoke)return backtest.chart({...request,source:'replay'});
    if(!nativeConnection.connected&&!smoke)throw new Error('圖表需要先連接 Shioaji 真實行情');
    if(chartBusy)throw new Error('圖表資料正在載入');chartBusy=true;
    try{const selected=service!;await selected.enqueue(()=>selected.engine.inspectSymbol(request.symbol,new Date()));
      return await liveChart(request,selected.engine.settings,join(dataRoot,'backtests','cache'),chartAbort.signal);}
    finally{chartBusy=false;}
  });
  handle('trader:replay-control',value=>backtest.control(z.enum(['pause','resume','step']).parse(value)));
  handle('trader:replay-speed',value=>backtest.speed(z.number().finite().min(0).max(60).parse(value)));
  handle('trader:export-market',async()=>{
    if(backtest.progress.running)throw new Error('回測完成後才能匯出回測資料');
    const dataset=await backtest.marketData(),result=await dialog.showSaveDialog(window!,{title:'匯出回測資料',defaultPath:'Shioaji-history.json',filters:[
      {name:'完整 JSON（分鐘、暖機日 K、每日股票池）',extensions:['json']},{name:'分鐘行情 CSV（不含暖機與股票池）',extensions:['csv']}]});
    if(result.canceled||!result.filePath)return '已取消匯出';
    const csv=result.filePath.toLowerCase().endsWith('.csv');
    writeFileSync(result.filePath,csv?replayMinutesCsv(dataset):JSON.stringify(dataset),{mode:0o600});
    return csv?'分鐘行情 CSV 已匯出（不含每日股票池及暖機日 K）':'完整回測資料已匯出（含分鐘行情、暖機日 K、每日股票池及入池日期）';
  });
  handle('trader:codex-login',value=>{
    if(smoke)throw new Error('Codex 登入不在測試流程執行');
    return codexLogin.start(value==='device');
  });
  handle('trader:codex-open',()=>{if(smoke)throw new Error('Codex 登入不在測試流程執行');return codexLogin.reopen();});
  handle('trader:codex-test',async()=>{
    if(smoke||!service)throw new Error('Codex 連線測試不在隔離流程執行');
    const testedService=service,result=await codexLogin.test(testedService.engine.settings);
    if(service===testedService&&codexLogin.status.test_state==='connected')await testedService.enqueue(()=>testedService.clearCodexFailure());
    return result;
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
function refreshWorkspaceStatus():void {
  if(service?.engine.connected&&workspaceDiagnostic?.stage==='api'&&workspaceDiagnostic.state!=='read_only'){
    workspaceDiagnostic={...workspaceDiagnostic,state:'ready',code:'',issue:''};initialError='';
  }
}
function connected():boolean{refreshWorkspaceStatus();return ((smoke&&!smokeConnection)||nativeConnection.connected)&&!!service?.engine.connected;}
function diagnosticSnapshot(){
  if(smoke&&!smokeConnection){const at=new Date().toISOString();return {version:'1.7.7',stream_connected:true,generation:1,trade_cache:'Healthy',
    health:{status:'healthy' as const,token_stale:false,ca_expired:false},endpoints:[
      {endpoint:'/health',stage:'登入狀態',attempts:1,successes:1,failures:0,last_attempt_at:at,last_success_at:at,issue:'',http_status:null,retry_at:null},
      {endpoint:'/portfolio/account_balance',stage:'交割戶餘額',attempts:2,successes:1,failures:1,last_attempt_at:at,last_success_at:at,
        issue:'隔離介面測試：Shioaji 交割戶餘額讀取失敗（HTTP 503）',http_status:503,retry_at:null}]};}
  const broker=service?.broker instanceof PaperBroker?service.broker.market:service?.broker;
  const result=mergeDiagnostics(nativeConnection.diagnostics(),broker instanceof ShioajiHttpBroker?broker.diagnosticSnapshot():null);
  result.startup={...result.startup,phase:connectionStatus().phase,issue:initialError||result.startup?.issue||''};
  result.workspace=workspaceDiagnostic;result.app_version=app.getVersion();return result;
}
async function enableLive(startAutomation:boolean,afterAuthorization?:(selected:TradingService)=>Promise<string>):Promise<string>{
  return operations.run(async()=>{
    const selected=service,epoch=liveActionEpoch;
    if(!selected||mode!=='live'||!nativeConnection.connected)throw new Error('請先連接實盤帳戶');
    if(startAutomation&&!await codexLogin.check())throw new CodexError('Codex 尚未登入，請先按登入');
    if(!(startAutomation?selected.liveAuthorized:selected.liveCancelAuthorized)){
      if(quitting||epoch!==liveActionEpoch||selected!==service)throw new Error('實盤啟動已停止');
      await selected.activateLive(startAutomation?'trade':'cancel');
    }else await selected.prepareLive();
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
  if(codexLogin.catalog.length)return codexLogin.catalog.map(m=>m.model);
  try {const raw=JSON.parse(readFileSync(join(dataRoot,'codex-login','models_cache.json'),'utf8')) as {models?:{slug?:string}[]};
    return (raw.models??[]).flatMap(m=>typeof m.slug==='string'?[m.slug]:[]).slice(0,50);
  }catch{return [];}
}
async function smokeTest(): Promise<void> {
  if (!window || !service || initialError || mode !== 'demo') throw new Error('桌面測試未啟動');
  if (process.platform === 'win32' && !tray) throw new Error('Windows 系統匣未啟動');
  smokeMark('CODEX_NATIVE');
  const version = await promisify(execFile)(bundledCodexPath(),['--version'],{timeout:20000,windowsHide:true});
  if (!version.stdout.includes('codex')) throw new Error('Codex 打包執行檔無法啟動');
  const isolatedAuth=join(dataRoot,'smoke-auth');prepareCodexProfile(isolatedAuth,join(dataRoot,'empty-auth'));
  const isolatedEnv=codexEnvironment(process.env,isolatedAuth);delete isolatedEnv.OPENAI_API_KEY;delete isolatedEnv.CODEX_API_KEY;
  let signedOut=false;
  try{await promisify(execFile)(bundledCodexPath(),['-c','cli_auth_credentials_store="file"','login','status'],{env:isolatedEnv,timeout:20000,windowsHide:true});}
  catch(error){const result=error as {code?:number;stdout?:string;stderr?:string};signedOut=result.code===1&&/not logged in/i.test((result.stdout??'')+(result.stderr??''));}
  if(!signedOut)throw new Error('打包後 Codex 隔離登入狀態未通過');
  smokeMark('SHIOAJI_NATIVE');
  if(!process.argv.includes('--ui-only')||app.isPackaged){const binary=await brokerPath();
    const native=await promisify(execFile)(binary,['--version'],{timeout:20000,windowsHide:true,env:{...process.env,PATH:''}});
    if(!native.stdout.includes('1.7.7'))throw new Error('內建 Shioaji 版本未通過');
    const help=await promisify(execFile)(binary,['server','start','--help'],{timeout:20000,windowsHide:true});
    if(!help.stdout.includes('--no-open'))throw new Error('內建 Shioaji 啟動方式未通過');
  }
  smokeMark('RENDERER');
  if (!window.webContents.isLoading()) await verifyRenderer();
  else await new Promise<void>((resolve,reject) => {
    window!.webContents.once('did-finish-load',() => { void verifyRenderer().then(resolve,reject); });
    window!.webContents.once('did-fail-load',() => reject(new Error('視窗未載入')));
  });
  smokeMark('TRADING');await service.command('auto on'); await service.command('pause');
  if (!service.engine.pausedEntries || !service.engine.settings.auto_execute) throw new Error('指令測試失敗');
  await service.command('resume');
  const virtual=new Date('2026-10-08T10:00:00+08:00'),snapshot=await service.engine.snapshot(virtual);
  await service.engine.activate(demoAnalysis(snapshot,service.engine.settings,virtual),snapshot,virtual);
  for(let n=0;n<4;n++)await service.engine.tick(new Date(virtual.getTime()+n*3000));
  if(!service.engine.watch.entries.length||!service.store.orders().some(o=>o.filled>0))throw new Error('打包後動態觀測與條件執行未通過');
  smokeMark('REPLAY');backtest.start({start:'2026-10-01',end:'2026-10-08',source:'sample',strategy:'demo',initial_cash:'100000',strategy_schedule:'interval',comparison_intervals:[120,180]},service.engine.settings);
  await backtest.wait();
  if(!backtest.report||backtest.report.status!=='COMPLETED'||!backtest.report.metrics.filled_orders)throw new Error('打包後歷史模擬未通過');
  const metrics=backtest.report.metrics;
  if(!metrics.total_costs||!metrics.gross_pnl||backtest.report.quality.execution_model!=='APPROXIMATE'
    ||Math.abs(Number(metrics.gross_pnl)-Number(metrics.total_costs)-Number(metrics.net_pnl))>.02)throw new Error('打包後成本拆分與近似成交標示未通過');
  if(backtest.comparisons.length!==2)throw new Error('打包後排程比較未通過');
  await verifyRenderer();
  const qualityUi=await window.webContents.executeJavaScript(`({quality:document.querySelector('#bt-quality').textContent,cost:document.querySelector('#bt-cost').textContent})`);
  if(!qualityUi.quality.includes('近似成交')||!qualityUi.quality.includes('固定股票池')||!qualityUi.cost.includes('費用前損益'))throw new Error('打包後回測品質與成本介面未通過');
  const expectedStock=await window.webContents.executeJavaScript(`(()=>{const buttons=[...document.querySelectorAll('#overview-watch td button')];buttons[1]?.click();buttons[2]?.click();return buttons[2]?.textContent;})()`);
  await new Promise(resolve=>setTimeout(resolve,1800));
  const selected=await window.webContents.executeJavaScript(`document.querySelector('#chart-name').textContent`);
  if(!expectedStock||!selected.includes(expectedStock))throw new Error('快速切換股票圖表未通過');
  await window.webContents.executeJavaScript(`document.querySelector('#chart-start').value='2020-03-02';document.querySelector('#chart-end').value='2020-03-03'`);
  await backtest.select(backtest.comparisons[0]!.id);await new Promise(resolve=>setTimeout(resolve,1500));
  const range=await window.webContents.executeJavaScript(`({start:document.querySelector('#chart-start').value,end:document.querySelector('#chart-end').value,schedule:document.querySelector('#schedule-strategy').textContent})`);
  if(range.start!==backtest.report.request.start||range.end!==backtest.report.request.end
    ||range.schedule!==backtest.report.request.decision_interval_minutes+' 分鐘'||backtest.progress.total_runs!==undefined)throw new Error('切換歷史報表日期與排程未通過');
  smokeMark('REPLAY_GUI');window.webContents.debugger.attach('1.3');
  const artifacts=process.env.TRADER_SMOKE_OUTPUT??join(process.cwd(),'release');mkdirSync(artifacts,{recursive:true});
  for(const [width,height] of [[1600,960],[1366,768],[1920,1080]] as const){
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await window.webContents.executeJavaScript(`(()=>{document.querySelector('#bt-start').value='2026-10-01';document.querySelector('#bt-end').value='2026-10-08';document.querySelector('#chart-symbol').value='9001';document.querySelector('#chart-start').value='2026-10-01';document.querySelector('#chart-end').value='2026-10-08';document.querySelector('#chart-form').requestSubmit();})()`);
    await new Promise(resolve=>setTimeout(resolve,1800));
    await verifyLayout('paper','replay');
    if(width===1600)await verifyPositionSelection('replay');
    if(!await window.webContents.executeJavaScript(`(()=>{const note=document.querySelector('#bt-progress-message');return note.getBoundingClientRect().height>0&&getComputedStyle(note).visibility!=='hidden'&&note.textContent.includes('近似成交');})()`))throw new Error('精簡與寬版回測近似成交警示不可見');
    if(width===1600)await verifyChartInteraction();
    await capture(`SYNTHETIC-ui-paper-${width}.png`,width,height);
    if(width===1600){
      const capital=await window.webContents.executeJavaScript(`(()=>{
        const profile=document.querySelector('#bt-capital-profile');
        document.querySelector('#replay-settings-dialog').showModal();
        return {profile:profile.value,options:[...profile.options].map(o=>o.value),metrics:document.querySelector('#bt-capital').textContent,
          basis:document.querySelector('#s-order-basis').value};
      })()`);
      if(capital.profile!=='active'||capital.options.join(',')!=='active,balanced,custom'||!capital.metrics.includes('持倉')
        ||!['EQUITY','AFTER_RESERVE'].includes(capital.basis))throw new Error('回測資金配置、持倉比例與單筆計算基準介面未通過');
      await capture('SYNTHETIC-ui-capital-profile.png',width,height);
      await window.webContents.executeJavaScript(`document.querySelector('#replay-settings-dialog').close()`);
    }
  }
  await service.command('auto off');
  const recordedAt=new Date().toISOString();
  for(let n=0;n<260;n++)service.store.recordAnalystEvent({id:'smoke-event-'+n,at:recordedAt,asof:recordedAt,
    stage:n===258?'MODEL':n===257?'SNAPSHOT':n===256?'DATA':'REASONING',message:n===258?'隔離測試模型：isolated-smoke-model':n===257?'隔離測試：完整快照':n===256?'股票池 20 檔 · 歷史已就緒 18 檔 · 基本資格與流動性合格 1 檔':`隔離測試推理摘要 ${n}：行情、現金、持倉與買賣條件已核對。完整內容保留，不截斷。`,
    model:'isolated-smoke-model',reasoning:'high',purpose:'STRATEGY',...(n===257?{details:{cash:'100000',symbol:'9001',marker:'COMPLETE_SNAPSHOT'}}:
      n===256?{details:{pool_count:20,history_ready:18,eligible_symbols:['9001'],history_issues:[{symbol:'9002',issue:'隔離歷史測試 HTTP 503'}]}}:{})});
  service.analystEvents=service.store.analystEvents();
  await window.webContents.executeJavaScript(`window.trader.simulationScope('realtime')`);
  smokeMark('PAPER_GUI');
  for(const [width,height] of [[1600,960],[1366,768],[1920,1080]] as const){
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await new Promise(resolve=>setTimeout(resolve,1300));await verifyLayout('paper','realtime');
    if(width===1600)await verifyPositionSelection('realtime');
    const realtime=await window.webContents.executeJavaScript(`(async()=>{const state=await window.trader.state();return {cash:Number(document.querySelector('#cash').textContent.replaceAll(',','')),
      runtimeCash:Number(state.runtime.account.cash),replayCash:Number(state.backtest_result.metrics.final_cash),source:document.querySelector('#chart-source').value,
      model:document.querySelector('#codex-effective-model').textContent,summary:document.querySelector('#analyst-stream').textContent,
      compact:state.analyst_events.filter(e=>e.context==='live').every(e=>e.details===undefined)};})()`);
    const expectedCash=Number(spendableCash(service.engine.account!,service.engine.settings).available);
    if(Math.abs(realtime.cash-expectedCash)>.01||realtime.runtimeCash===realtime.replayCash||realtime.source!=='live'||!realtime.model.includes('isolated-smoke-model')||!realtime.summary.includes('不截斷')||!realtime.summary.includes('資料就緒')||!realtime.summary.includes('歷史已就緒 18 檔')||!realtime.compact)throw new Error('即時模擬帳戶、圖表來源、資料就緒與完整摘要未通過');
    await capture(`SYNTHETIC-ui-realtime-${width}.png`,width,height);
  }
  smokeMark('SMART_GUI');
  // Real renderer capture of isolated, explicitly labelled stateful-condition fixtures.
  const smartNow=new Date(),smartSnapshot=await service.engine.snapshot(smartNow),smartAnalysis=demoAnalysis(smartSnapshot,service.engine.settings,smartNow);
  const smartSymbol=smartSnapshot.universe[0]!.symbol,smartPrice=d(smartSnapshot.universe[0]!.last);
  const smartSpec={stop_price:smartPrice.times('.90').toFixed(2),take_profit:null,reward_target:smartPrice.times('1.15').toFixed(2),
    trailing_activate:smartPrice.times('1.05').toFixed(2),trailing_fraction:'0.03'};
  smartAnalysis.decisions=[{symbol:smartSymbol,action:'BUY',shares:30,limit_price:smartPrice.times('1.01').toFixed(2),entry_when:'REBOUND',
    trigger_price:smartPrice.times('.99').toFixed(2),rebound_fraction:'0.02',smart:smartSpec,conditions:[],reason:'隔離智慧條件介面測試，不是股票建議'}];
  await service.engine.activate(smartAnalysis,smartSnapshot,smartNow);
  service.store.saveEntryTrack({symbol:smartSymbol,plan_id:service.engine.plan!.id,lot:'ODD',armed:true,
    low_water:smartPrice.times('.97').toFixed(2),observed_at:smartNow.toISOString()});
  service.store.saveProtection({symbol:smartSymbol,plan_id:service.engine.plan!.id,spec:smartSpec,high_water:smartPrice.times('1.10').toFixed(2),
    trailing_armed:true,observed_at:smartNow.toISOString(),triggered:''});
  await window.webContents.executeJavaScript(`(()=>{document.querySelector('#chart-symbol').value=${JSON.stringify(smartSymbol)};
    document.querySelector('#chart-form').requestSubmit();document.querySelector('.conditions-details').open=true;})()`);
  for(const [width,height] of [[1600,960],[1366,768],[1920,1080]] as const){
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await new Promise(resolve=>setTimeout(resolve,1400));await verifyLayout('paper','realtime');
    const smartUi=await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('#stock-conditions'),pane=document.querySelector('.instrument-panel');
      if(innerHeight<900)pane.scrollTop=pane.scrollHeight;else pane.scrollTop=0;
      const box=pane.getBoundingClientRect(),rows=[...node.querySelectorAll('.condition-item')].filter(n=>['反彈追蹤','優先停損','移動退場價'].includes(n.querySelector('span').textContent));
      return {text:node.textContent,allVisible:rows.length===3&&rows.every(n=>{const r=n.getBoundingClientRect();return r.top>=box.top&&r.bottom<=box.bottom&&r.right<=box.right}),
      open:document.querySelector('.conditions-details').open,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    if(!smartUi.open||smartUi.overflow||height>=900&&!smartUi.allVisible||!['低點','高點','已啟動','收益目標（不觸發）','優先停損'].every(v=>smartUi.text.includes(v)))
      throw new Error('反彈低點、移動高點、優先停損與成本目標介面未通過');
    await capture(`SYNTHETIC-ui-smart-conditions-${width}.png`,width,height);
  }
  await window.webContents.executeJavaScript(`document.querySelector('.conditions-details').open=false`);
  await window.webContents.executeJavaScript(`document.querySelector('#open-diagnostics').click()`);await new Promise(resolve=>setTimeout(resolve,400));
  const diag=await window.webContents.executeJavaScript(`(async()=>{const s=await window.trader.state();return {open:document.querySelector('#diagnostics-dialog').open,
    text:document.querySelector('#diagnostic-endpoints').textContent,data:JSON.stringify(s.broker_diagnostics)};})()`);
  if(!diag.open||!diag.text.includes('503')||!diag.text.includes('交割戶餘額')||/SYNTHETIC_KEY|SYNTHETIC_SECRET|SYNTHETIC_PASSWORD|account_id|ca_password/.test(diag.data))throw new Error('連線診斷端點、具體錯誤或敏感資料隔離未通過');
  const originalSave=dialog.showSaveDialog;
  try{dialog.showSaveDialog=async()=>({canceled:false,filePath:join(dataRoot,'diagnostics-fixture.json')});
    await window.webContents.executeJavaScript(`window.trader.exportDiagnostics()`);
    const saved=JSON.parse(readFileSync(join(dataRoot,'diagnostics-fixture.json'),'utf8'));
    if(saved.version!==app.getVersion()||!saved.diagnostics.endpoints.length||/SYNTHETIC_KEY|SYNTHETIC_SECRET|SYNTHETIC_PASSWORD|account_id|ca_password/.test(JSON.stringify(saved)))throw new Error('診斷匯出包含敏感資料或版本未通過');
  }finally{dialog.showSaveDialog=originalSave;}
  await capture('SYNTHETIC-ui-diagnostics.png',1920,1080);await window.webContents.executeJavaScript(`document.querySelector('#diagnostics-dialog').close()`);
  await window.webContents.executeJavaScript(`document.querySelector('#analyst-stream [data-event-id="smoke-event-257"] details').open=true`);await new Promise(resolve=>setTimeout(resolve,400));
  const tail=service.store.analystEvent('smoke-event-259')!;service.store.recordAnalystEvent({...tail,message:tail.message+' · 串流持續更新'});service.analystEvents=service.store.analystEvents();
  await new Promise(resolve=>setTimeout(resolve,1300));
  if(!await window.webContents.executeJavaScript(`(()=>{const detail=document.querySelector('#analyst-stream [data-event-id="smoke-event-257"] details');return detail.open&&detail.textContent.includes('COMPLETE_SNAPSHOT')})()`))throw new Error('Codex 串流更新收起正在檢視的完整快照');
  await window.webContents.executeJavaScript(`document.querySelector('#analyst-history-open').click()`);await new Promise(resolve=>setTimeout(resolve,500));
  const journal=await window.webContents.executeJavaScript(`(async()=>{const full=await window.trader.analystHistory('runtime'),detail=await window.trader.analystDetail('runtime','smoke-event-257');
    const view=document.querySelector('#analyst-history-records');return {open:document.querySelector('#analyst-history-dialog').open,count:view.querySelectorAll('.analyst-event').length,
      full:full.length,first:view.textContent.includes('推理摘要 0'),detail:detail.marker==='COMPLETE_SNAPSHOT'};})()`);
  if(!journal.open||journal.count!==260||journal.full!==260||!journal.first||!journal.detail)throw new Error('超過畫面上限的完整 Codex 紀錄未通過');
  await capture('SYNTHETIC-ui-codex-history.png',1920,1080);await window.webContents.executeJavaScript(`document.querySelector('#analyst-history-dialog').close()`);
  mode='live';
  smokeMark('LIVE_GUI');
  for(const [width,height] of [[1600,960],[1366,768],[1920,1080]] as const){
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await new Promise(resolve=>setTimeout(resolve,1300));await verifyLayout('live','realtime');
    if(width===1600)await verifyPositionSelection('realtime');
    await capture(width===1600?'SYNTHETIC-ui-live.png':`SYNTHETIC-ui-live-${width}.png`,width,height);
  }
  const liveUi=await window.webContents.executeJavaScript(`(async()=>({ack:!!document.querySelector('#ack'),button:document.querySelector('#start-live').textContent,
    authorized:(await window.trader.state()).live.authorized,rejected:await window.trader.authorizeLive().then(()=>false,()=>true)}))()`);
  if(liveUi.ack||!liveUi.button.includes('開始自動交易')||liveUi.authorized||!liveUi.rejected)throw new Error('實盤帳戶與自動交易分開或測試隔離未通過');
  mode='demo';
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1600,height:960,deviceScaleFactor:1,mobile:false});
  await vault.save({api_key:'SYNTHETIC_KEY',secret_key:'SYNTHETIC_SECRET',ca_path:'SYNTHETIC.pfx',ca_password:'SYNTHETIC_PASSWORD',remember:true});credentialState=await vault.status();
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
  const prefilled=await window.webContents.executeJavaScript(`({key:document.querySelector('#api-key').value==='SYNTHETIC_KEY',secret:document.querySelector('#secret-key').value==='SYNTHETIC_SECRET',
    ca:document.querySelector('#ca-path').value==='SYNTHETIC.pfx',password:document.querySelector('#ca-password').value==='SYNTHETIC_PASSWORD',masked:document.querySelector('#ca-password').type==='password'})`);
  if(!credentials.visible||credentials.key!=='password'||credentials.secret!=='password'||!credentials.ca||credentials.removed||!Object.values(prefilled).every(Boolean))throw new Error('帳戶設定與加密欄位自動填回未通過');
  await capture('SYNTHETIC-ui-connection.png',1600,960);
  await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('#api-key');input.value='SYNTHETIC_UNSAVED';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settings-dialog').close();document.querySelector('#open-settings').click();})()`);
  await new Promise(resolve=>setTimeout(resolve,250));
  if(!await window.webContents.executeJavaScript(`document.querySelector('#api-key').value==='SYNTHETIC_UNSAVED'`))throw new Error('重新開啟設定覆蓋未儲存金鑰');
  await window.webContents.executeJavaScript(`document.querySelector('#forget-keys').click()`);await new Promise(resolve=>setTimeout(resolve,350));
  if(!await window.webContents.executeJavaScript(`['api-key','secret-key','ca-path','ca-password'].every(id=>document.getElementById(id).value==='')`))throw new Error('清除記憶後欄位未清空');
  await window.webContents.executeJavaScript(`document.querySelector('#settings-dialog').close();document.querySelector('[data-dialog="history-dialog"]').click()`);
  await capture('SYNTHETIC-ui-history.png',1600,960);
  await window.webContents.executeJavaScript(`document.querySelector('#history-dialog').close()`);
  await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');window.webContents.debugger.detach();
  async function capture(name:string,width:number,height:number):Promise<void>{
    const shot=await window!.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:0,y:0,width,height,scale:1}}) as {data:string};
    writeFileSync(join(artifacts,name),Buffer.from(shot.data,'base64'));
  }
  async function verifyPositionSelection(source:'replay'|'realtime'):Promise<void>{
    const expected=await window!.webContents.executeJavaScript(`(()=>{
      const rows=[...document.querySelectorAll('#positions tbody tr[data-chart-symbol]')];
      const row=rows.at(-1);if(!row)return null;
      row.querySelector('td:nth-child(2)').click();return row.dataset.chartSymbol;
    })()`);
    await new Promise(resolve=>setTimeout(resolve,1400));
    const selected=await window!.webContents.executeJavaScript(`({symbol:document.querySelector('#chart-symbol').value,
      title:document.querySelector('#chart-name').textContent,source:document.querySelector('#chart-source').value,
      selected:document.querySelector('#positions tr.selected')?.dataset.chartSymbol,
      cutoff:document.querySelector('#market-chart').dataset.endAt})`);
    if(!expected||selected.symbol!==expected||!selected.title.includes(expected)||selected.selected!==expected
      ||selected.source!==(source==='replay'?'replay':'live')||source==='replay'&&Date.parse(selected.cutoff)>Date.parse(backtest.report!.asof))
      throw new Error('持倉整列點選、主圖與工作台行情來源未同步：'+JSON.stringify(selected));
    const keyboard=await window!.webContents.executeJavaScript(`(()=>{
      const row=document.querySelector('#positions tr[data-chart-symbol]');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return row.dataset.chartSymbol;
    })()`);
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(!await window!.webContents.executeJavaScript(`document.querySelector('#chart-name').textContent.includes(${JSON.stringify(keyboard)})&&document.querySelector('#positions tr.selected')?.dataset.chartSymbol===${JSON.stringify(keyboard)}`))
      throw new Error('持倉鍵盤切換主圖未通過');
    console.log('Electron positions click and keyboard chart selection, '+source+' cutoff: PASS');
  }
  async function verifyChartInteraction():Promise<void>{
    const pause=()=>new Promise(resolve=>setTimeout(resolve,120));
    const view=()=>window!.webContents.executeJavaScript(`(()=>{const host=document.querySelector('#market-chart'),box=host.getBoundingClientRect();return {
      offset:Number(host.dataset.offset),count:Number(host.dataset.count),scale:Number(host.dataset.priceScale),end:host.dataset.endAt,
      maximum:Number(document.querySelector('#chart-pan').max),disabled:document.querySelector('#chart-pan').disabled,
      x:box.x+box.width*.5,y:box.y+box.height*.45,right:box.right-25,dragging:host.classList.contains('dragging')};})()`);
    await window!.webContents.executeJavaScript(`(()=>{const select=document.querySelector('#chart-window');select.value='30';select.dispatchEvent(new Event('change'));document.querySelector('#chart-latest').click();})()`);await pause();
    const latest=await view();if(latest.count!==30||latest.disabled||latest.offset!==latest.maximum)throw new Error('圖表縮放與最新位置未通過');
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:latest.x,y:latest.y,deltaY:-150,deltaX:0});await pause();
    const zoomed=await view();if(zoomed.count>=latest.count||zoomed.count<15)throw new Error('圖表滑鼠滾輪縮放未通過');
    await window!.webContents.executeJavaScript(`document.querySelector('#chart-latest').click()`);await pause();const origin=await view();
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:origin.x,y:origin.y,button:'left',clickCount:1});
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:origin.x+140,y:origin.y,button:'left',buttons:1});
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:origin.x+140,y:origin.y,button:'left',clickCount:1});await pause();
    const dragged=await view();if(dragged.offset>=origin.offset||dragged.dragging)throw new Error('圖表滑鼠拖曳平移未通過');
    await window!.webContents.executeJavaScript(`(()=>{const range=document.querySelector('#chart-pan');range.value='0';range.dispatchEvent(new Event('input'));})()`);await pause();
    const slider=await view();if(slider.offset!==0)throw new Error('圖表底部時間軸未通過');
    await window!.webContents.executeJavaScript(`document.querySelector('#chart-form').requestSubmit()`);await new Promise(resolve=>setTimeout(resolve,1200));
    const refreshed=await view();if(refreshed.offset!==0||refreshed.count!==slider.count)throw new Error('行情更新重設正在檢視的圖表位置');
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:refreshed.right,y:refreshed.y,button:'left',clickCount:1});
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:refreshed.right,y:refreshed.y+40,button:'left',buttons:1});
    await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:refreshed.right,y:refreshed.y+40,button:'left',clickCount:1});await pause();
    const scaled=await view();if(scaled.scale===refreshed.scale)throw new Error('圖表右側價格軸拖曳縮放未通過');
    if(Date.parse(scaled.end)>Date.parse(backtest.report!.asof))throw new Error('圖表操作看見模擬時間以後的行情');
    await window!.webContents.executeJavaScript(`document.querySelector('#market-chart').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await pause();
    const reset=await view();if(reset.scale!==1||reset.offset!==reset.maximum)throw new Error('圖表雙擊重設未通過');
    const result=await window!.webContents.executeJavaScript(`({strategy:document.querySelector('#bt-strategy').value,flow:document.querySelectorAll('[data-replay-stage]').length,workflow:document.querySelectorAll('#bt-workflow tbody tr').length})`);
    if(result.strategy!=='codex'||result.flow!==6||result.workflow<5)throw new Error('每日 Codex 模擬流程與完整步驟報表未通過');
    const replayControls=await window!.webContents.executeJavaScript(`(async()=>{
      const direct=document.querySelector('#replay-mode'),slider=document.querySelector('#replay-speed'),number=document.querySelector('#replay-speed-number');
      direct.value='accelerated';direct.dispatchEvent(new Event('change'));number.value='17';number.dispatchEvent(new Event('change'));
      await new Promise(resolve=>setTimeout(resolve,100));const precise=(await window.trader.state()).replay_speed;
      slider.value='29';slider.dispatchEvent(new Event('input'));await new Promise(resolve=>setTimeout(resolve,100));const sliding=(await window.trader.state()).replay_speed;
      direct.value='direct';direct.dispatchEvent(new Event('change'));await new Promise(resolve=>setTimeout(resolve,100));const fast=(await window.trader.state()).replay_speed;
      return {precise,sliding,fast,numeric:number.value,disabled:slider.disabled&&number.disabled,mode:direct.value,range:slider.type,strategyType:document.querySelector('#bt-strategy').type,
        monitor:document.querySelector('#bt-monitor').value,readonly:document.querySelector('#bt-monitor').readOnly};
    })()`);
    if(replayControls.precise!==17||replayControls.sliding!==29||replayControls.fast!==0||!replayControls.disabled||replayControls.mode!=='direct'||replayControls.numeric!=='29'||replayControls.range!=='range'||replayControls.strategyType!=='hidden'||replayControls.monitor!=='5'||!replayControls.readonly)
      throw new Error('完整 Codex 策略、五分鐘條件檢查、拉桿與精確倍速切換未通過');
    const savedClock=backtest.clock,savedProgress=backtest.progress;
    const clock=new ReplayClock(state=>{if(window&&!window.isDestroyed())window.webContents.send('trader:replay-clock',state);});
    const at=backtest.frame!.at,abort=new AbortController();backtest.clock=clock;
    backtest.progress={...savedProgress,running:true,phase:'REPLAY'};clock.setSpeed(10);await clock.before(at,abort.signal);
    await new Promise(resolve=>setTimeout(resolve,1200));
    const label=async()=>Date.parse(await window!.webContents.executeJavaScript(`document.querySelector('#replay-time').dataset.at`));
    const waiting=clock.before(new Date(Date.parse(at)+30000).toISOString(),abort.signal);
    await new Promise(resolve=>setTimeout(resolve,350));const moving=await label();
    if(moving<=Date.parse(at)+1000||moving>=Date.parse(at)+10000)throw new Error('加速播放沒有連續顯示模擬秒數');
    clock.command('pause');await new Promise(resolve=>setTimeout(resolve,100));const paused=await label();
    await new Promise(resolve=>setTimeout(resolve,250));if(await label()!==paused)throw new Error('暫停後秒數仍持續前進');
    clock.command('resume');await new Promise(resolve=>setTimeout(resolve,300));if(await label()<=paused)throw new Error('恢復加速後秒數未繼續');
    clock.setSpeed(0);await waiting;const frozen=clock.snapshot().at;
    await new Promise(resolve=>setTimeout(resolve,100));const frozenLabel=await label();
    await new Promise(resolve=>setTimeout(resolve,200));if(await label()!==frozenLabel||frozenLabel!==Date.parse(frozen))throw new Error('事件處理或 Codex 等待期間秒數未凍結');
    backtest.clock=savedClock;backtest.progress=savedProgress;savedClock.setSpeed(0);
    console.log('Electron accelerated seconds, pause/resume and event-boundary freeze: PASS');
    for(const rsi of [true,false]){await window!.webContents.executeJavaScript(`(()=>{const input=document.querySelector('#chart-rsi');input.checked=${rsi};input.dispatchEvent(new Event('input'));})()`);await pause();
      const panes=await window!.webContents.executeJavaScript(`(()=>{const host=document.querySelector('#market-chart'),bottom=n=>{const b=n.getBBox();return b.y+b.height;},time=Math.min(...[...host.querySelectorAll('[data-pane="time"]')].map(n=>n.getBBox().y));
        return {time,volume:Math.max(...[...host.querySelectorAll('[data-pane="volume"]')].map(bottom)),rsi:host.querySelector('[data-pane="rsi"]')?bottom(host.querySelector('[data-pane="rsi"]')):0};})()`);
      if(panes.volume>=panes.time||panes.rsi>=panes.time)throw new Error('圖表成交量、RSI 與時間軸文字重疊');
    }
    await window!.webContents.executeJavaScript(`document.activeElement?.blur()`);
    console.log('Electron wheel zoom, pointer pan, price-axis drag, bottom range, preserved viewport, cutoff and replay workflow: PASS');
  }
  async function verifyLayout(expected:string,scope:'realtime'|'replay'):Promise<void>{
    const result=await window!.webContents.executeJavaScript(`(()=>{
      const visible=selector=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight&&box.right<=innerWidth;};
      return {mode:document.body.dataset.workspace,scope:document.body.dataset.simulation,watchRows:document.querySelectorAll('#overview-watch tbody tr').length,
        watchPrices:[...document.querySelectorAll('#overview-watch tbody tr td:nth-child(3)')].some(cell=>cell.textContent!=='—'),pnl:document.querySelector('#bt-pnl').textContent,
        panels:['.watch-panel','.positions-panel','.chart-panel','.codex-panel','.execution-panel'].every(visible),auth:['#codex-login','#codex-test','#codex-device'].every(visible),
        simulation:visible('.simulation-controls'),equity:visible('.equity-panel'),orders:visible('#orders'),runtime:visible('.runtime-controls'),
        pages:document.querySelectorAll('[data-page],[data-tab]').length,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,
        viewport:innerWidth,viewportHeight:innerHeight,times:document.querySelector('#s-times').value,
        settings:document.querySelector('#settings-dialog').open};})()`);
    if(result.mode!==expected||result.scope!==scope||!result.panels||!result.auth||result.pages||result.width>result.viewport||result.height>result.viewportHeight||result.settings
      ||expected==='paper'&&scope==='replay'&&(!result.simulation||!result.equity||result.runtime||result.orders||result.watchRows<5||!result.watchPrices||result.pnl==='—')
      ||scope==='realtime'&&(!result.orders||!result.runtime||result.simulation||result.equity))throw new Error('單一工作台版面未通過：'+JSON.stringify(result));
  }
  const before = window.isVisible(); window.hide(); if (window.isVisible()) throw new Error('隱藏測試失敗');
  window.show(); if (before && !window.isVisible()) throw new Error('重開測試失敗');
  window.minimize();await new Promise(resolve=>setTimeout(resolve,200));activateWindow(window);
  await new Promise(resolve=>setTimeout(resolve,200));
  if(window.isMinimized()||!window.isVisible())throw new Error('縮到系統匣後未能還原視窗');
  for(const status of ['ready','active','paused','offline'])if(trayIcon(status).isEmpty())throw new Error('原生狀態圖示未打包');
  if(process.platform==='win32'&&(nativeOverlayClears<2||nativeImage.createFromPath(join(directory,'assets/app.ico')).isEmpty()))throw new Error('Windows 固定主圖示與不重疊狀態驗證未通過');
  console.log('Electron single workspace at 1366/1600/1920, realtime paper/replay/live, complete model journal, masked saved credentials, built-in Shioaji, chart gestures and native status icons: PASS');
  smokeMark('CONNECTION_GUI');await verifyConnectionLifecycle();smokeChecksCompleted=true;smokeMark('EXIT');await exit();
}
async function verifyRenderer(): Promise<void> {
  const result = await window!.webContents.executeJavaScript(`(async () => ({ bridge: typeof window.trader?.state === 'function',
    node: typeof window.require, status: (await window.trader.state()).status,
    workspaces:document.querySelectorAll('.terminal-grid').length,codex:!!document.querySelector('.codex-panel'),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content }))()`);
  if (!result.bridge || result.node !== 'undefined' || !result.status || !result.csp || result.workspaces!==1||!result.codex) throw new Error('安全 IPC 或單一工作台未載入');
}
async function verifyConnectionLifecycle():Promise<void>{
  if(!smoke||!window||!service)throw new Error('Connection test must be isolated');
  const sample=service.store.orders()[0];await service.close();service=undefined;
  const originalNative=nativeConnection;await originalNative.close();
  const fixture=new ConnectionSmoke();smokeConnection=true;smokeMarket=fixture.market;smokeReadMarket=fixture.reader;
  if(!window.webContents.debugger.isAttached())window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1600,height:960,deviceScaleFactor:1,mobile:false});
  nativeConnection=fixture.native(join(dataRoot,'connection-fixture'));mode='paper';simulationScope='realtime';
  await vault.clear();credentialState=await vault.status();initialError='';fixture.failWorkspace=true;
  const js=(source:string)=>window!.webContents.executeJavaScript(source);
  const wait=async(condition:string)=>{const deadline=Date.now()+12000;while(!await js(condition)){
    if(Date.now()>deadline)throw new Error('First-login GUI regression did not finish: '+condition);await new Promise(resolve=>setTimeout(resolve,80));}};
  const state=()=>js('window.trader.state()') as Promise<DesktopState>;
  await js('document.querySelector("#open-settings").click()');await new Promise(resolve=>setTimeout(resolve,400));
  await js('for(const [id,value] of [["api-key","SYNTHETIC_KEY"],["secret-key","SYNTHETIC_SECRET"]]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));}document.querySelector("#remember-keys").checked=true;document.querySelector("#connect-api").click()');
  await wait('document.querySelector("#settings-dialog .dialog-message.failed")?.textContent.includes("交易工作台隔離測試載入失敗")');
  let current=await state();if(!current.connection.remembered||current.runtime||fixture.launches||current.connected||!current.broker_diagnostics?.startup?.issue)throw new Error('Missing-workspace save, no redundant login or startup diagnostic failed');
  if(!await js('document.querySelector("#settings-dialog").open && document.querySelector("#settings-dialog .dialog-message.failed").getBoundingClientRect().height>0'))throw new Error('Login error is hidden behind the modal');
  if(!await js('!document.querySelector("#connection-status").textContent.includes("已連線") && document.querySelector("#runtime-workspace-name").textContent.includes("即時模擬")'))throw new Error('Modal connection text or pipeline mode retained a stale ready state');
  await captureConnection('SYNTHETIC-ui-login-failure.png');
  fixture.failWorkspace=false;fixture.nativeFailure=true;
  await js('document.querySelector("#connect-saved").click()');
  await wait('document.querySelector("#settings-dialog .dialog-message.failed")?.textContent.includes("SIGN_TIME")');
  current=await state();if(current.connected||!current.connection.remembered||current.broker_diagnostics?.startup?.code!=='SIGN_TIME'
    ||current.broker_diagnostics.startup.process_exit_code!==17||JSON.stringify(current.broker_diagnostics).includes('SYNTHETIC_'))
    throw new Error('Native process failure lost its safe classification, exit code or saved login');
  await captureConnection('SYNTHETIC-ui-native-login-failure.png');
  if(!await js('!document.querySelector("#repair-login-time").hidden && !document.querySelector("#connection-status").textContent.includes("CA")'))throw new Error('Signing repair is missing or failed login still claims a CA problem');
  await js('document.querySelector("#repair-login-time").click()');
  await wait('window.trader.state().then(s=>s.connected)');
  await wait('!document.querySelector("#settings-dialog").open');
  current=await state();if(fixture.clockRepairs!==2||fixture.mutations||current.broker_diagnostics?.startup?.code
    ||current.broker_diagnostics?.startup?.clock_repair!=='synced')throw new Error('One-click signing repair did not recover safely');
  // Force a cold connection for the following production-environment validation.
  await nativeConnection.close();
  await js('document.querySelector("#open-settings").click()');
  await wait('document.querySelector("#settings-dialog").open');
  fixture.nativeFailure=false;fixture.simulation=true;
  await js('document.querySelector("#connect-saved").click()');
  await wait('document.querySelector("#settings-dialog .dialog-message.failed")?.textContent.includes("未取得正式行情")');
  current=await state();if(!current.connection.remembered||!current.broker_diagnostics?.endpoints.some(e=>e.endpoint==='/info')||current.connected)throw new Error('A failed native login lost its saved settings or endpoint record');
  if(JSON.stringify(current.broker_diagnostics).includes('SYNTHETIC_'))throw new Error('Startup diagnostics leaked credential/account fixture data');
  fixture.simulation=false;await js('document.querySelector("#connect-saved").click()');
  await wait('!document.querySelector("#settings-dialog").open && document.querySelector("#sidebar-connection").textContent.includes("已連線")');
  current=await state();if(!current.connected||!current.runtime?.connected||!current.connection.remembered)throw new Error('Saved-login recovery failed');
  const paperService=service as TradingService|undefined;
  if(!sample||!paperService)throw new Error('Pending paper order fixture unavailable');
  paperService.store.insertIntent({...sample,local_id:'SYNTHETIC-PENDING',tag:'SYN001',status:'PENDING',filled:0});
  await js('document.querySelector("[data-mode=live]").click()');
  await wait('document.body.dataset.workspace==="live" && document.querySelector("[data-mode=live]").classList.contains("active")');
  current=await state();if(current.workspace_mode!=='live'||!current.connected)throw new Error('A paper order blocked live-workspace switching');
  fixture.failWorkspace=true;await js('window.trader.configure("paper")');await new Promise(resolve=>setTimeout(resolve,1200));
  current=await state();if(!current.connection.server_ready||current.connected||current.runtime||!await js('document.querySelector("#sidebar-connection").textContent==="工作台待恢復" && document.querySelector("#headline").textContent==="工作台尚未就緒" && document.querySelector("#runtime-workspace-name").textContent.includes("即時模擬") && !document.querySelector("#connection-status").textContent.includes("已連線")'))throw new Error('Native/workspace availability still contradicts the GUI');
  await captureConnection('SYNTHETIC-ui-workspace-failure.png');
  fixture.failWorkspace=false;const launches=fixture.launches;
  await js('document.querySelector("#open-settings").click()');await new Promise(resolve=>setTimeout(resolve,400));
  await js('document.querySelector("#connect-api").click()');
  await wait('!document.querySelector("#settings-dialog").open && document.querySelector("#sidebar-connection").textContent.includes("已連線")');
  current=await state();if(!current.connected||fixture.launches!==launches||fixture.mutations)throw new Error('Retry required another login or attempted a live mutation');
  await captureConnection('SYNTHETIC-ui-login-ready.png');
  const livePath=join(dataRoot,'live.db'),legacy=new Store(livePath);
  legacy.set('database_mode','readonly');legacy.insertIntent({...sample,local_id:'SYNTHETIC-HISTORY',tag:'SYNHIS',status:'FILLED',filled:sample.shares});legacy.close();
  await js('document.querySelector("[data-mode=live]").click()');
  await wait('document.body.dataset.workspace==="live" && document.querySelector("#sidebar-connection").textContent.includes("已連線")');
  current=await state();const migrated=service as TradingService|undefined;
  if(!current.connected||migrated?.store.get('database_mode')!=='live'||!migrated?.store.orders().some(o=>o.local_id==='SYNTHETIC-HISTORY'))throw new Error('Legacy readonly account history did not survive the live-mode switch');
  await captureConnection('SYNTHETIC-ui-legacy-live.png');
  await js('window.trader.configure("paper")');
  const savePreferences=commonSettings.save.bind(commonSettings);
  try {
    commonSettings.save=()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_PREFERENCE_PATH'),{code:'EPERM'});};
    await js('window.trader.configure("live")');current=await state();
    if(!current.connected||current.broker_diagnostics?.workspace?.stage!=='preferences'||current.broker_diagnostics.workspace.code!=='EPERM')throw new Error('A preference-write failure prevented authenticated account reads');
    if(JSON.stringify(current.broker_diagnostics).includes('SYNTHETIC_PRIVATE'))throw new Error('Preference diagnostics exposed a private path');
    await captureConnection('SYNTHETIC-ui-preferences-warning.png');
  }finally{commonSettings.save=savePreferences;}
  await js('window.trader.configure("paper")');
  const incompatible=new Store(livePath);incompatible.set('schema_version',999);incompatible.close();
  await js('document.querySelector("[data-mode=live]").click()');
  await wait('document.body.dataset.workspace==="live" && document.querySelector("#sidebar-connection").textContent.includes("帳務可讀")');
  current=await state();const reader=service as TradingService|undefined;
  if(!current.connected||!current.runtime?.account?.available?.cash||current.broker_diagnostics?.workspace?.code!=='SCHEMA_VERSION'
    ||current.broker_diagnostics.workspace.state!=='read_only'||!reader?.persistenceIssue||reader.liveAuthorized||fixture.mutations)throw new Error('Unavailable live journal did not preserve safe account reads and disable trading');
  await js('document.querySelector("#open-diagnostics").click()');await new Promise(resolve=>setTimeout(resolve,400));
  if(!await js('document.querySelector("#diagnostic-workspace").textContent.includes("SCHEMA_VERSION") && document.querySelector("#diagnostic-endpoints").textContent.includes("account_balance")'))throw new Error('The GUI did not expose the local failure stage and successful portfolio endpoints');
  await captureConnection('SYNTHETIC-ui-live-readonly.png');
  if(!await js('!document.querySelector("#workspace-retry").hidden && !document.querySelector("#workspace-retry").disabled'))throw new Error('Local recovery button is unavailable in account-read-only mode');
  await js('document.querySelector("#workspace-retry").click()');
  await wait('document.querySelector("#diagnostics-dialog .dialog-message.failed")?.textContent.includes("SCHEMA_VERSION")');
  current=await state();const failedRetry=service as TradingService|undefined;
  if(!current.connected||!current.runtime?.account?.available?.cash||current.broker_diagnostics?.workspace?.state!=='read_only'
    ||!failedRetry?.persistenceIssue.includes('SCHEMA_VERSION')||failedRetry.liveAuthorized||current.runtime.auto||fixture.mutations)
    throw new Error('An unsuccessful journal retry lost account reads or enabled live trading');
  const {DatabaseSync}=await import('node:sqlite'),repair=new DatabaseSync(livePath);
  repair.prepare('UPDATE kv SET value=? WHERE key=?').run('2','schema_version');repair.close();
  await js('document.querySelector("#workspace-retry").click()');
  await wait('document.querySelector("#workspace-retry").hidden && document.querySelector("#diagnostic-workspace").textContent.includes("已就緒")');
  // The smoke fixture has no monitoring timer. Read the next reconciled snapshot
  // after SSE establishes its initial generation, using the actual read-only IPC.
  await js('window.trader.command("reconcile")');
  await wait('window.trader.state().then(s=>s.runtime?.account?.complete)');
  current=await state();const recovered=service as TradingService|undefined;
  if(!current.connected||!current.runtime?.account?.complete||current.live.authorized||current.runtime.auto||recovered?.persistenceIssue
    ||!recovered?.store.orders().some(o=>o.local_id==='SYNTHETIC-HISTORY')||current.broker_diagnostics?.workspace?.issue||fixture.mutations)throw new Error('Journal recovery discarded historical orders, retained an old diagnostic or resumed live execution');
  await captureConnection('SYNTHETIC-ui-live-recovered.png');
  if(fixture.launches!==launches)throw new Error('Workspace mode/profile recovery relaunched an already-healthy native login');
  console.log('Legacy live journal, preference-write failure, safe Pro-compatible account reader, failed retry and GUI journal recovery passed; zero live mutations.');
  console.log('Cold-start login, encrypted-save failure/recovery, modal feedback, shared live login and zero live mutations passed.');
  async function captureConnection(name:string){const root=process.env.TRADER_SMOKE_OUTPUT??join(directory,'../../../release');mkdirSync(root,{recursive:true});
    await js('document.querySelector("#mode-badge").textContent="隔離連線測試 · 虛構資料"');
    const shot=await window!.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}) as {data:string};writeFileSync(join(root,name),Buffer.from(shot.data,'base64'));}
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
  if(trayTimer)clearInterval(trayTimer);
  codexLogin?.close();await codexLogin?.wait();
  backtest?.cancel();await backtest?.wait();
  await service?.close(); service = undefined;await nativeConnection?.close();
  if (blocker !== undefined) powerSaveBlocker.stop(blocker);
  tray?.destroy(); window?.destroy();
  if (smoke){rmSync(dataRoot,{recursive:true,force:true});if(smokeDeadline)clearTimeout(smokeDeadline);
    smokeMark(smokeChecksCompleted?'PASSED':'FAILED',smokeChecksCompleted?'':'GUI checks did not complete');
    if(!smokeChecksCompleted){app.exit(1);return;}}
  app.quit();
}
