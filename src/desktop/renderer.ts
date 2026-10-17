import {replayDisplayTime} from './replay-time.js';
import type {ReplayClockState} from '../core/replay-clock.js';
import type { DesktopState,TraderBridge } from './shared.js';
import type { Settings,Decision } from '../core/models.js';
import { candles,equityChart } from './charts.js';
import { ChartViewport } from './chart-viewport.js';
import type { ChartData,ChartRequest } from '../core/chart.js';
import type { BacktestRequest } from '../core/backtest.js';
import type { AnalystEvent } from '../core/codex.js';
import { simulationView,replayView,workspaceCutoff,workspaceRuntime,workspaceEvents } from './workspace.js';
import {entryDiagnosticText} from '../core/entry-diagnostics-text.js';
declare global {interface Window {trader:TraderBridge}}
const guardText=(decision:Decision):string=>(decision.conditions??[]).map(c=>`${c.left} ${{GT:'>',GTE:'≥',LT:'<',LTE:'≤'}[c.operator]} ${c.right==='VALUE'?c.value:c.right}`).join(' 且 ');
const triggerText=(d:Decision):string=>d.entry_when==='IMMEDIATE'?'條件檢查後':d.entry_when==='REBOUND'
  ?`先跌至 ${d.trigger_price}，再自低點回升 ${Number(d.rebound_fraction)*100}%`
  :`${d.entry_when==='BELOW'?'低於':'高於'} ${d.trigger_price}`;
// Rounded display hints only; all actual triggers use Decimal in the engine.
const thresholdHint=(value:number):string=>Number.isFinite(value)?Number(value.toFixed(4)).toString():'—';
const el=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
const text=(id:string,value:unknown):void=>{const node=el(id),v=String(value??'—');if(node.textContent!==v)node.textContent=v;};
const value=(id:string):string=>el<HTMLInputElement>(id).value;
const checked=(id:string):boolean=>el<HTMLInputElement>(id).checked;
const fmt=(v:string|number|undefined):string=>v===undefined||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('zh-TW',{maximumFractionDigits:2});
const pct=(v:string):string=>fmt(Number(v)*100)+'%';
const time=(v:string|null|undefined):string=>v?new Date(v).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,hour:'2-digit',minute:'2-digit'}):'—';
const stamp=(v:string|null|undefined):string=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const phase:Record<string,string>={IDLE:'尚未執行',LOADING:'準備行情',CALENDAR:'交易日曆',UNIVERSE:'股票資料池',HISTORY:'歷史行情',SNAPSHOT:'當時快照',ANALYSIS:'Codex 選股',ACTIVATION:'設定條件',MONITOR:'偵測與送單',RECONCILE:'成交核對',SUBMISSION:'模擬委託',FILL:'模擬成交',RISK:'風控阻擋',CLOSE:'收盤核對',LIMIT:'呼叫上限',REVIEW:'盤後檢討',REPLAY:'事件已完成',COMPLETED:'已完成',PARTIAL:'部分完成',CANCELLED:'已停止',FAILED:'執行失敗'};
Object.assign(phase,{TRIGGER:'條件觸發',SIGNAL_STATE:'監測狀態',DATA:'資料就緒',MODEL:'實際模型',RUNNING:'選股與條件分析',HALTED:'Codex 已停止',RECOVERED:'Codex 連線恢復',REASONING:'官方推理摘要',OUTPUT:'完整結構回覆',PLAN:'分析步驟',USAGE:'用量',VALIDATING:'核對輸出',DECISION:'策略決定',
  SIZING:'Codex 確認股數',SIZE_CONFIRM:'數量與風控核對',SIZE_DECISION:'交易數量建議',EXECUTION_RESULT:'本次執行結果',SUBMISSION:'委託送出'});
const action:Record<string,string>={BUY:'買進',SELL:'賣出',HOLD:'觀望',ADD:'加入',REMOVE:'移除',RETAIN:'保留監控',OBSERVE:'觀測',RETAINED:'保留監控',WAIT:'等待',BLOCKED:'風控／資格阻擋',SUBMITTED:'已送出',FILLED:'已成交',PARTIAL:'部分成交',PENDING:'委託中',CANCEL_PENDING:'撤單核對中',CANCELLED:'已撤單',REJECTED:'已拒絕',UNKNOWN:'結果待核對'};
Object.assign(action,{SIZING:'Codex 確認股數',SIZE_FAILED:'數量確認未完成',QUEUED:'等待數量確認',RUNNING:'確認股數中'});
Object.assign(action,{TRACKING:'追蹤低點',EXPIRED:'追蹤超時',TRIGGERED:'已觸發',BREAKEVEN:'保本退場'});
type Cell=string|number|{label:string;command?:string;report?:string;chartSymbol?:string};
function table(id:string,headers:string[],rows:Cell[][],empty='目前沒有資料'):void {
  const host=el(id),signature=JSON.stringify([headers,rows,empty]);if(host.dataset.signature===signature)return;host.dataset.signature=signature;
  const t=document.createElement('table'),head=t.createTHead().insertRow();
  for(const h of headers){const cell=document.createElement('th');cell.textContent=h;head.append(cell);}
  const body=t.createTBody();
  if(!rows.length){const cell=body.insertRow().insertCell();cell.colSpan=headers.length;cell.className='empty';cell.textContent=empty;}
  for(const row of rows){const tr=body.insertRow();for(const v of row){const td=tr.insertCell();
    if(typeof v==='object'){const b=document.createElement('button');b.className='quiet';b.textContent=v.label;
      b.addEventListener('click',()=>void run(()=>v.chartSymbol?showStock(v.chartSymbol):v.report?window.trader.selectBacktest(v.report):window.trader.command(v.command!)));td.append(b);
    }else td.textContent=String(v);}
    const stock=row.find(v=>typeof v==='object'&&v.chartSymbol) as {chartSymbol:string}|undefined;
    if(stock){tr.dataset.chartSymbol=stock.chartSymbol;tr.tabIndex=0;tr.title=`查看 ${stock.chartSymbol} 行情與智慧條件`;
      tr.addEventListener('click',event=>{if(!(event.target as HTMLElement).closest('button'))void run(()=>showStock(stock.chartSymbol));});
      tr.addEventListener('keydown',event=>{if(event.target===tr&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void run(()=>showStock(stock.chartSymbol));}});
    }
  }
  host.replaceChildren(t);
  markSelectedStock();
}
function markSelectedStock():void{for(const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-chart-symbol]')){
  const selected=row.dataset.chartSymbol===selectedSymbol;row.classList.toggle('selected',selected);if(selected)row.setAttribute('aria-current','true');else row.removeAttribute('aria-current');}}
let messageTimer:ReturnType<typeof setTimeout>|undefined;
const message=(s:string,failed=false):void=>{text('message',s);el('message').classList.add('visible');clearTimeout(messageTimer);messageTimer=setTimeout(()=>el('message').classList.remove('visible'),6000);
  for(const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')){
    let banner=dialog.querySelector<HTMLParagraphElement>('.dialog-message');if(!banner){banner=document.createElement('p');banner.className='dialog-message';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');dialog.prepend(banner);}
    banner.textContent=s;banner?.classList.toggle('failed',failed);
  }};
async function run(operation:()=>Promise<unknown>):Promise<void>{message('正在處理…');try{message(String(await operation()??'完成'));}
  catch(e){message(e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'操作未完成',true);}
  finally{try{await refresh();}catch{message('工作台資料尚未載入，請查看連線診斷',true);}}}
let codexDirty=false;let latestState:DesktopState|undefined;
let settingsDirty=false,polling=false,latestSettings:Settings|undefined,renderedReport='';
let replayPreferencesLoaded=false;
let currentWorkspace='';
function updateWorkspace(state:DesktopState):void {
  const mode=simulationView(state)?'paper':'live';document.body.dataset.workspace=mode;
  document.body.dataset.simulation=state.simulation_scope??'replay';
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-simulation]')){
    const selected=button.dataset.simulation===(state.simulation_scope??'replay');button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
    button.disabled=state.connection.busy||button.dataset.simulation==='realtime'&&state.backtest_running;
  }
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')){
    const selected=button.dataset.mode===mode;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
  }
  const workspace=mode+':'+(mode==='paper'?state.simulation_scope??'replay':'live');
  if(currentWorkspace!==workspace){currentWorkspace=workspace;chartData=undefined;chartSignature='';chartGeneration++;
    el<HTMLInputElement>('chart-source').value=replayView(state)?'replay':'live';
    el('market-chart').replaceChildren();el('market-chart').classList.add('chart-empty');
    text('market-chart',replayView(state)?'開始回放後，圖表、監測與持倉會一起跟隨虛擬時間':'選取股票或輸入代碼，載入真實行情');
    if(!replayView(state)&&state.connected)void loadChart().catch(()=>undefined);
  }
}
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-simulation]'))button.addEventListener('click',()=>void run(()=>window.trader.simulationScope(button.dataset.simulation as 'realtime'|'replay')));
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))button.addEventListener('click',()=>void run(async()=>{
  const result=await window.trader.configure(button.dataset.mode!);settingsDirty=false;return result;
}));
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog]'))button.addEventListener('click',()=>{
  el<HTMLDialogElement>(button.dataset.dialog!).showModal();if(button.dataset.dialog==='settings-dialog')void loadSavedConnection().catch(()=>undefined);
});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close]'))button.addEventListener('click',()=>button.closest('dialog')?.close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();const e=event as MouseEvent;
  if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)dialog.close();}});
const guided:Record<string,keyof Settings>={
  's-schedule':'strategy_schedule','s-interval':'decision_interval_minutes','s-monitor':'monitor_interval_seconds','s-watch':'watch_refresh_minutes',
  's-review':'postmarket_time','s-count':'watch_max_symbols','s-misses':'watch_remove_after_scans','s-amount':'watch_min_amount',
  's-url':'base_url','s-account':'stock_account_index','s-cash':'demo_cash',
  's-fee':'fee_rate','s-min-fee':'minimum_fee',
  's-order-basis':'order_budget_basis','s-target':'target_exposure_fraction','s-reward-risk':'min_entry_reward_risk','s-trade-risk':'max_trade_risk_fraction',
  's-quotes':'manage_quote_subscriptions','s-min-cash':'min_cash_fraction','s-order-limit':'max_order_fraction','s-symbol-limit':'max_symbol_fraction','s-loss-limit':'daily_loss_fraction',
  's-watch-auto':'auto_watchlist','s-whole':'whole_lots','s-awake':'keep_awake','s-minimized':'start_minimized',
  's-entry-mode':'entry_strategy_mode','s-adaptive':'adaptive_protection','s-dynamic':'dynamic_allocation',
  's-slip':'risk_slippage_fraction','s-gap':'overnight_gap_fraction','s-gap-risk':'max_gap_risk_fraction',
  's-min-profit':'min_net_profit_twd','s-track-minutes':'entry_tracking_minutes',
};
function schedulingFields(prefix:'s'|'bt'):void {
  const fixed=value(prefix+'-schedule')==='fixed';el<HTMLInputElement>(prefix+'-times').disabled=!fixed;el<HTMLInputElement>(prefix+'-interval').disabled=fixed;
}
function loadSettings(s:Settings):void {
  for(const [id,key] of Object.entries(guided)){const node=el<HTMLInputElement>(id),v=s[key];
    if(typeof v==='boolean')node.checked=v;else node.value=String(v);}
  if(!codexDirty){el<HTMLInputElement>('codex-model-control').value=s.codex_model;el<HTMLSelectElement>('codex-reasoning-control').value=s.codex_reasoning;el<HTMLTextAreaElement>('codex-instruction-control').value=s.codex_instruction;}
  if(!replayPreferencesLoaded){replayPreferencesLoaded=true;
    for(const [id,v] of Object.entries({'bt-schedule':s.strategy_schedule,'bt-times':s.strategy_times.join(','),'bt-interval':s.decision_interval_minutes,
      'bt-monitor':5,'bt-watch':5,'bt-cash':s.demo_cash}))el<HTMLInputElement>(id).value=String(v);
    el<HTMLInputElement>('bt-whole').checked=s.whole_lots;schedulingFields('bt');
  }
  el<HTMLInputElement>('s-times').value=s.strategy_times.join(',');el<HTMLSelectElement>('mode').value=s.mode==='live'?'live':'paper';
  el<HTMLTextAreaElement>('settings').value=JSON.stringify(s,null,2);text('settings-state','已儲存');schedulingFields('s');
}
function renderRuntime(state:DesktopState):void {
  const r=workspaceRuntime(state),s=latestSettings,paper=replayView(state);
  const riskSettings=s&&paper?{...s,...(state.backtest_progress.running?state.backtest_progress.effective_settings:state.backtest_result?.settings)} as Settings:s;
  const accountOnly=state.connection.phase==='read_only';
  el('connection-dot').classList.toggle('connected',state.connected&&!accountOnly);el('connection-dot').classList.toggle('pending',accountOnly||!!state.connection.server_ready&&!state.connected||state.connection.busy);
  text('sidebar-connection',state.connection.busy?'連線中':accountOnly?'帳務可讀 · 委託暫停':state.connected?'Shioaji 已連線':state.connection.server_ready?'工作台待恢復':state.connection.phase==='failed'?'連線未完成':'尚未登入');
  text('connection-status',`${state.connection.status} · ${state.connection.has_ca?'CA 已載入':'實盤委託需有效 CA'}`);
  text('runtime-workspace-name',simulationView(state)?paper?'歷史回放 · 當時行情':'即時模擬 · 虛擬資金':'正式交易 · 真實帳戶');
  text('runtime-orders-title',simulationView(state)?'模擬委託與成交':'未完成委託');
  el('live-authorization').hidden=simulationView(state);text('live-account',state.live.account);text('live-settings-status',state.live.issues.join('；'));
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))button.disabled=state.connection.busy;
  if(s){text('mode-badge',s.mode==='demo'?'介面測試 · 虛構行情':simulationView(state)?paper?'真實行情 · 歷史回放':'真實行情 · 虛擬資金':'真實行情 · 實盤帳戶');el('mode-badge').classList.toggle('live',!simulationView(state));}
  text('error',state.error);text('status',paper?state.backtest:state.status);text('logs',(paper?state.backtest_result?.logs??[]:state.logs).slice(-35).join('\n'));
  text('experience',state.experience);text('codex-login-status',state.codex_login);
  if(!r||!s){text('headline',state.connection.busy?'連線中':state.connection.server_ready?'工作台尚未就緒':'請先登入 Shioaji');text('runtime-note',state.error||state.connection.status);
    for(const id of ['cash','equity','next-strategy','watch-count'])text(id,'—');text('cash-detail','等待帳戶資料');text('settlement-detail','等待交割資料');text('data-status','工作台尚未就緒');
    for(const id of ['positions','orders','overview-watch','watchlist','watch-changes','decisions'])table(id,['狀態'],[],'工作台尚未完成連線');return;}
  const labels={demo:'介面測試資料',paper:'模擬 · 真實行情',readonly:'實盤監控',live:'實盤 · 真實帳戶'};
  text('mode-badge',s.mode==='demo'?'介面測試 · 虛構行情':simulationView(state)?paper?'真實行情 · 歷史回放':'真實行情 · 虛擬資金':'真實行情 · 實盤帳戶');el('mode-badge').classList.toggle('live',r.mode==='live');
  const valid=r.plan&&Date.parse(r.plan.analysis.expires_at)>Date.parse(workspaceCutoff(state));
  text('headline',!r.connected?'等待連線':r.killed?'已停止新委託':!r.auto?'監控已開啟':r.paused?'買進已暫停':!r.session?'交易時段外，持續監控':!valid?'等待有效策略':r.blocked||!r.watch.healthy?'新買進暫停，保護監控持續':'全自動偵測中');
  text('runtime-note',r.mode==='demo'?'虛構行情與模擬資金；日期區間測試可隨時執行。':r.mode==='readonly'?'帳戶核對模式；確認現金、交割與可賣量後再切換。':
    r.auto?'定時更新條件；觸發後再由 Codex 確認數量，送單前重新核對風控。':'按「開始自動交易」建立首輪條件，之後依每日排程更新。');
  if(paper){text('headline',!r.connected?'等待 API 連線':state.backtest_progress.running?(state.replay_paused?'模擬已暫停':'歷史模擬執行中'):state.backtest_result?'模擬結果已保存':'準備歷史模擬');
    text('runtime-note','圖表、持倉、監測與 Codex 使用同一個模擬時間');}
  const a=r.account;
  if(a){const stocks=a.positions.reduce((sum,p)=>sum+Number(p.last_price)*p.shares,0);
    const have=a.available??{cash:true,settlements:true,positions:true,orders:true};
    text('equity',have.cash&&have.positions&&have.settlements?fmt(Number(a.cash)-Number(a.settlement_debits)+Number(a.settlement_credits)+stocks):'—');
    const reserves=a.orders.filter(o=>o.action==='BUY'&&!['FILLED','CANCELLED','REJECTED'].includes(o.status))
      .reduce((sum,o)=>sum+Number(o.limit_price)*(o.shares-o.filled)+Math.max(Number(s.minimum_fee),Math.ceil(Number(o.limit_price)*(o.shares-o.filled)*Number(s.fee_rate))),0);
    text('cash',have.cash&&have.settlements&&have.orders?fmt(Math.max(0,Number(a.cash)-Number(a.settlement_debits)-reserves)):have.cash?fmt(a.cash):'—');
    text('cash-detail',have.cash&&(!have.settlements||!have.orders)?'交割戶餘額 · 可用資金仍在核對':have.positions?`股票市值 ${fmt(stocks)} · ${a.complete?'帳務已更新':'部分資料待更新'}`:'持倉正在載入');
    text('settlement-detail',have.settlements?`交割預留 ${fmt(a.settlement_debits)} · 待收 ${fmt(a.settlement_credits)}`:'交割資料正在載入');
    text('data-status',`${paper?'模擬時間':a.complete?'帳戶已核對':'帳戶未確認'} · ${stamp(a.asof)}`);
  }else{text('equity',paper?fmt(value('bt-cash')):'—');text('cash',paper?fmt(value('bt-cash')):'—');text('cash-detail',paper?'設定的初始本金':'等待帳戶資料');text('settlement-detail',paper?'開始模擬後顯示交割款':'等待交割資料');text('data-status',paper?'等待開始模擬':'等待帳戶核對');}
  text('watch-count',r.watch.entries.length);text('watch-detail',r.watch.issue||`候選 ${r.watch.entries.filter(w=>w.state==='OBSERVE').length} · 持倉／掛單保留 ${r.watch.entries.filter(w=>w.state==='RETAINED').length}`);
  text('next-label',paper?'模擬時間':'下一輪 Codex');text('next-strategy',paper?time(workspaceCutoff(state)):time(r.next_strategy_at));text('next-detail',paper?stamp(workspaceCutoff(state)):r.next_strategy_at?`${stamp(r.next_strategy_at)} · 台北`:'等待已驗證交易日');
  const replaySettings=paper&&!state.backtest_progress.running?state.backtest_result?.request:undefined;
  const marketCadence=paper&&(state.backtest_progress.running?value('bt-entry-cadence')==='market':replaySettings?.entry_cadence==='market');
  text('schedule-strategy',paper?(replaySettings?(replaySettings.strategy_schedule==='fixed'?replaySettings.strategy_times.join(' / '):replaySettings.decision_interval_minutes+' 分鐘'):
    value('bt-schedule')==='fixed'?value('bt-times'):value('bt-interval')+' 分鐘'):s.strategy_schedule==='fixed'?s.strategy_times.join(' / '):s.decision_interval_minutes+' 分鐘');text('analysis-status',paper?phase[state.backtest_progress.phase]??state.backtest_progress.phase:r.sizing?'確認股數':r.analyzing?'條件分析中':valid?'監測中':'等待策略');
  text('schedule-monitor',marketCadence?'進場／智慧逐筆':paper&&['0.2.3','0.2.2','0.2.1'].includes(state.backtest_result?.version??'')?'300 秒／智慧逐筆':(paper?replaySettings?.monitor_interval_seconds??300:s.monitor_interval_seconds)+' 秒');text('monitor-status',`最近偵測 ${stamp(r.last_monitor_at)}`);
  text('schedule-watch',(paper?replaySettings?.watch_refresh_minutes??value('bt-watch'):s.watch_refresh_minutes)+' 分鐘');text('scan-status',r.scanning?'正在更新觀測':`最近更新 ${stamp(r.watch.asof)}`);
  el('live-authorization').hidden=r.mode!=='live';
  const live=state.live;
  text('live-state',r.killed?'交易已停止':r.auto&&live.authorized?'自動交易執行中':live.ready?'實盤帳戶已就緒':r.connected?'實盤已連線 · 資料更新中':'等待帳戶連線');
  text('live-account',live.account);text('live-issues',live.issues[0]??'帳務持續更新 · 自動交易依策略與風控執行');
  el('live-issues').title=live.issues.join('；');
  text('live-settings-status',live.issues.length?live.issues.join('；'):'實盤帳戶已就緒；不需另外啟動或確認授權');
  text('start-live',state.connection.busy?'正在核對…':r.auto&&!r.killed?'▶ 自動交易中':'▶ 開始自動交易');
  el<HTMLButtonElement>('start-live').disabled=state.connection.busy||r.auto&&!r.paused&&!r.killed;
  el<HTMLButtonElement>('lock-live').disabled=!live.authorized&&!r.auto;
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))button.disabled=state.connection.busy;
  text('wall-clock',new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}));
  const rows=r.watch.entries.map(w=>{const q=r.quotes.find(q=>q.symbol===w.symbol&&q.odd),d=r.decisions.find(d=>d.symbol===w.symbol);
    const detail=d?.reason??(!w.eligible?w.reason:!valid?'等待有效策略':!r.auto?'等待啟動自動交易':'等待價格條件或下一輪個股決策');
    const decision=r.plan?.analysis.decisions.find(d=>d.symbol===w.symbol),protection=r.protections.find(p=>p.symbol===w.symbol);
    return [{label:w.symbol,chartSymbol:w.symbol},w.name,q?fmt(q.last):'—',d?action[d.state]??d.state:action[w.state]] as Cell[];});
  table('overview-watch',['股票','名稱','現價','狀態'],rows,paper?'開始模擬後顯示當時的監測清單':'連接 API 後自動更新觀測清單');
  for(const [i,row] of [...el('overview-watch').querySelectorAll<HTMLTableRowElement>('tbody tr')].entries()){const w=r.watch.entries[i];if(!w)continue;
    row.classList.toggle('selected',w.symbol===selectedSymbol);row.title=r.decisions?.find(d=>d.symbol===w.symbol)?.reason??w.reason;}
  table('watchlist',['股票','名稱','來源','資格','評分','原因'],r.watch.entries.map(w=>[{label:w.symbol,chartSymbol:w.symbol},w.name,w.source==='CODEX'?'Codex 候選':'動態掃描',w.eligible?'已確認':action[w.state]??w.state,w.score,w.reason]));
  table('watch-changes',['台北時間','股票','動作','原因'],r.watch.changes.slice(-20).reverse().map(c=>[stamp(c.at),c.symbol,action[c.action]??c.action,c.reason]));
  table('positions',['股票','股數 / 可賣','成本 / 現價','未實現毛利'],(a?.positions??[]).map(p=>[{label:p.symbol,chartSymbol:p.symbol},`${fmt(p.shares)} / ${fmt(p.sellable)}`,`${fmt(p.average_price)} / ${fmt(p.last_price)}`,fmt((Number(p.last_price)-Number(p.average_price))*p.shares)]),a?.available?.positions===false?'持倉資料正在載入':'目前無持倉');
  markSelectedStock();
  const displayedOrders=simulationView(state)&&!paper?(a?.orders??[]).slice(-30).reverse():r.orders;
  table('orders',['股票 / 方向','成交 / 股數','限價','狀態',''],displayedOrders.map(o=>[`${o.symbol} ${action[o.action]}`,`${o.filled} / ${o.shares}`,o.limit_price,action[o.status]??o.status,
    ['FILLED','CANCELLED','REJECTED'].includes(o.status)?'已核對':o.purpose==='EXTERNAL'?'外部委託':{label:'撤單核對',command:'cancel '+o.local_id}]),simulationView(state)?'尚無即時模擬委託；條件觸發後會由 Codex 確認股數':'目前無未完成委託');
  text('runtime-workspace-name',simulationView(state)?'即時模擬 · 虛擬資金':'正式交易 · 真實帳戶');
  text('runtime-orders-title',simulationView(state)?'模擬委託與成交':'未完成委託');
  text('runtime-schedule-note',s.strategy_schedule==='fixed'?'每日 '+s.strategy_times.join(' / '):'盤中每 '+s.decision_interval_minutes+' 分鐘');
  text('runtime-strategy-step',r.analyzing?'Codex 分析中':r.next_strategy_at?'下一輪 '+time(r.next_strategy_at):'等待交易日');
  text('runtime-execution-step',`每 ${s.monitor_interval_seconds} 秒 · ${r.sizing?'Codex 股數確認中':'最近 '+time(r.last_monitor_at)}`);
  text('runtime-queue',r.execution_queue?.length?r.execution_queue.map(t=>`${t.symbol} ${action[t.action]} · ${action[t.state]??t.state}`).join('；'):'持倉持續監測出場；監測股票符合買進條件才觸發數量確認。');
  const stance={BUY_ALLOWED:'允許條件買進',HOLD_ONLY:'保留現金／觀望',REDUCE:'減碼優先'};
  text('strategy-stance',r.plan?stance[r.plan.analysis.stance]:'等待第一輪策略');text('strategy-summary',r.plan?.analysis.summary??'取得有效策略後，程式會依條件執行。');
  text('strategy-expiry',r.plan?`有效至 ${stamp(r.plan.analysis.expires_at)}${valid?'':' · 已到期'}`:'');
  const rule=r.plan?.analysis.screening?.entry;
  text('rule-summary',rule?`自動規則 ${rule.signal} · 每檔配置 ${pct(rule.allocation_fraction)} · 停損 ${pct(rule.stop_fraction)} · ${rule.trailing_fraction?'預估收益':'固定停利'} ${pct(rule.take_profit_fraction)} · 移動停損 ${rule.trailing_fraction?pct(rule.trailing_fraction):'關閉'}`:'依 Codex 個股決策執行；新加入股票等待授權條件');
  table('decisions',['股票','方向','參考股數','限價界線','觸發','策略理由'],(r.plan?.analysis.decisions??[]).map(d=>[{label:d.symbol,chartSymbol:d.symbol},action[d.action]??d.action,d.shares,d.limit_price,
    triggerText(d)+(guardText(d)?' 且 '+guardText(d):''),d.reason]),'本輪無個股委託；可能使用規則選股或全部觀望');
  text('watch-policy',`上限 ${riskSettings!.watch_max_symbols} · 持倉必留`);el('watch-policy').title=`候選上限 ${riskSettings!.watch_max_symbols}；持倉與掛單持續監測；連續 ${riskSettings!.watch_remove_after_scans} 次不符才移除`;
  text('risk-summary',`現金保留 ${pct(riskSettings!.min_cash_fraction)} · 單筆 ${pct(riskSettings!.max_order_fraction)}（${riskSettings!.order_budget_basis==='EQUITY'?'淨資產':'扣除保留後'}） · 單檔 ${pct(riskSettings!.max_symbol_fraction)} · 日損失 ${pct(riskSettings!.daily_loss_fraction)} 停止新買進`);
}
function renderBacktest(state:DesktopState):void {
  const p=state.backtest_progress,r=state.backtest_result;renderReplay(state);
  text('bt-progress-title',phase[p.phase]??p.phase);text('bt-progress-detail',`${p.total_runs&&p.total_runs>1?`第 ${p.run} / ${p.total_runs} 組 · `:''}${p.day} · Codex ${p.codex_calls}`);
  // The compact layout hides metric subtitles; keep the execution-model warning visible here.
  text('bt-progress-message',(r||p.running?'近似成交 · ':'')+p.message);el<HTMLProgressElement>('bt-progress').value=p.total_points?Math.round(p.points/p.total_points*100):p.phase==='COMPLETED'?100:0;
  el<HTMLButtonElement>('bt-run').disabled=p.running;el<HTMLButtonElement>('bt-compare').disabled=p.running;el<HTMLButtonElement>('bt-cancel').disabled=!p.running;
  for(const node of document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#backtest-form input,#backtest-form select,[form="backtest-form"]')){
    node.disabled=p.running;
  }
  if(!p.running)schedulingFields('bt');
  el('bt-result').hidden=!r;el<HTMLButtonElement>('bt-json').disabled=!r;el<HTMLButtonElement>('bt-csv').disabled=!r;
  el<HTMLButtonElement>('bt-market').disabled=p.running||!r?.dataset_id;
  if(!r){renderedReport='';text('bt-entry-diagnostics','測試完成後可查看進場與未成交診斷');table('bt-history',['日期區間','策略排程','淨損益','報酬','結果',''],state.backtest_history.map(h=>[`${h.start} — ${h.end}`,h.schedule,fmt(h.net_pnl),fmt(h.return_pct)+'%',phase[h.status]??h.status,{label:'檢視',report:h.id}]));return;}
  table('bt-history',['日期區間','策略排程','偵測','淨損益','報酬','回撤','呼叫','結果',''],state.backtest_history.map(h=>[`${h.start} — ${h.end}`,h.schedule,`${h.monitor_seconds} 秒`,fmt(h.net_pnl),fmt(h.return_pct)+'%',fmt(h.drawdown_pct)+'%',h.calls,
    (h.synthetic?'虛構 · ':'')+(phase[h.status]??h.status),{label:h.id===r.id?'檢視中':'檢視',report:h.id}]));
  if(renderedReport===r.id)return;renderedReport=r.id;const m=r.metrics;
  text('bt-result-title',`${r.synthetic?'虛構行情流程測試':'歷史模擬'} · ${r.request.start} 至 ${r.request.end} · ${phase[r.status]??r.status}`);
  text('bt-pnl',fmt(m.net_pnl));el('bt-pnl').className=Number(m.net_pnl)>=0?'positive':'negative';text('bt-return',`報酬 ${fmt(m.return_pct)}% · 已實現 ${fmt(m.realized_pnl)}`);
  text('bt-drawdown',fmt(m.max_drawdown_pct)+'%');text('bt-cost',`手續費 ${fmt(m.fees)} · 稅 ${fmt(m.taxes)}`+(m.gross_pnl!==undefined?` · 費用前損益 ${fmt(m.gross_pnl)}`:''));text('bt-filled',m.filled_orders);
  text('bt-activity',`觀測加入 ${m.watch_adds} / 移除 ${m.watch_removes} · Codex ${m.codex_calls}`);text('bt-equity',fmt(m.final_equity));
  text('bt-capital',m.average_exposure_pct===undefined?'舊報表未統計持倉比例':`持倉：行情時點平均 ${fmt(m.average_exposure_pct)}% · 最高 ${fmt(m.max_exposure_pct??'0')}% · ${r.request.capital_profile==='active'?'標準風控':r.request.capital_profile==='balanced'?'標準風控':'自訂風控'}`);
  text('bt-entry-diagnostics',entryDiagnosticText(r.entry_diagnostics));
  text('bt-quality',`近似成交 · ${r.quality.universe_mode==='DAILY_HISTORICAL'?'每日歷史股票池':'固定股票池'} · 行情 ${r.quality.covered_sessions}/${r.quality.sessions} 日 · 有效策略 ${r.quality.successful_strategies}/${r.quality.strategy_slots}`);
  table('bt-fills',['台北時間','股票','方向','股數','價格','手續費 / 稅','已實現損益'],r.fills.slice().reverse().map(f=>[stamp(f.at),f.symbol,action[f.action]??f.action,f.shares,fmt(f.price),`${fmt(f.fee)} / ${fmt(f.tax)}`,f.realized_pnl===null?'—':fmt(f.realized_pnl)]),'本次無成交；請核對策略、資料與風控紀錄');
  table('bt-daily',['日期','淨值','現金','待收交割'],r.daily_equity.map(d=>[d.day,fmt(d.equity),fmt(d.cash),fmt(d.settlement_credits)]));
  text('bt-strategy-log',r.strategy_log.map(s=>`${stamp(s.at)} ${s.review?'檢討':'策略'} ${s.stance}\n${s.summary}`).join('\n\n'));
  text('bt-limitations',[`實際處理截止：${stamp(r.asof)}${r.quality.halt_reason?' · Codex 故障停止，並非完整期間結果':''}`,
    `已處理交易日：${r.quality.processed_sessions??r.daily_equity.length}；賣出委託：${m.sell_orders??'舊報表未統計'}`,
    `暖機不足股票：${r.quality.insufficient_symbols.join('、')||'無'}`,`缺行情交易日：${r.quality.missing_sessions.join('、')||'無'}`,...r.limitations].join('\n'));
  table('bt-workflow',['台北時間','步驟','股票','條件與結果'],(r.workflow??[]).slice(-400).map(e=>[stamp(e.at),phase[e.stage]??e.stage,e.symbols?.join('、')??'—',e.message+
    (e.screening?`\n成交額 ≥ ${fmt(e.screening.min_amount)} · 量比 ≥ ${e.screening.min_volume_ratio} · RSI ${e.screening.rsi_min}–${e.screening.rsi_max}`+(e.screening.entry?` · ${e.screening.entry.signal} · 每檔 ${pct(e.screening.entry.allocation_fraction)} · 停損 ${pct(e.screening.entry.stop_fraction)} · 停利 ${pct(e.screening.entry.take_profit_fraction)}`:' · 僅觀測'):'')]),'此舊版報表沒有流程明細，重新執行模擬後會保存');
  if(r.failures?.length)text('bt-strategy-log',r.strategy_log.map(s=>`${stamp(s.at)} ${s.review?'檢討':'策略'} ${s.stance}\n${s.summary}`).join('\n\n')+'\n\n'+r.failures.map(f=>`${stamp(f.at)} ${phase[f.stage]??f.stage}：${f.issue}`).join('\n'));
  text('backtest',state.backtest);
  equityChart(el('equity-chart'),r.timeline??r.daily_equity.map(d=>({at:d.asof,equity:d.equity})),Number(r.metrics.initial_cash));
}
async function refresh():Promise<void>{if(polling)return;polling=true;
  try{const state=await window.trader.state();latestState=state;latestSettings=JSON.parse(state.settings) as Settings;updateWorkspace(state);if(!settingsDirty)loadSettings(latestSettings);renderRuntime(state);renderBacktest(state);renderExtras(state);refreshLivePrice(state);renderStockDetails();}
  finally{polling=false;}}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-command]'))b.addEventListener('click',()=>void run(()=>workspaceCommand(b.dataset.command!)));
el('workspace-retry').addEventListener('click',()=>void run(()=>window.trader.retryWorkspace()));
el('diagnostic-export').addEventListener('click',()=>void run(()=>window.trader.exportDiagnostics()));
el<HTMLFormElement>('command-form').addEventListener('submit',e=>{e.preventDefault();const command=value('command');el<HTMLInputElement>('command').value='';void run(()=>window.trader.command(command));});
el('hide').addEventListener('click',()=>void run(()=>window.trader.minimize()));el('exit').addEventListener('click',()=>void run(()=>window.trader.exit()));
const dirty=():void=>{settingsDirty=true;text('settings-state','尚未儲存');};
el('settings-form').addEventListener('input',dirty);el('settings-form').addEventListener('change',dirty);el('settings').addEventListener('input',dirty);
const times=(v:string):string[]=>v.split(/[,，、\s]+/).map(x=>x.trim()).filter(Boolean);
el<HTMLFormElement>('settings-form').addEventListener('submit',e=>{e.preventDefault();void run(async()=>{
  if(!latestSettings)throw new Error('設定尚未載入');const next={...latestSettings} as Record<string,unknown>;
  for(const [id,key] of Object.entries(guided)){const original=latestSettings[key];next[key]=typeof original==='boolean'?checked(id):typeof original==='number'?Number(value(id)):value(id);}
  next.strategy_times=times(value('s-times'));const result=await window.trader.saveSettings(JSON.stringify(next));settingsDirty=false;return result;
});});
el('save').addEventListener('click',()=>void run(async()=>{const result=await window.trader.saveSettings(value('settings'));settingsDirty=false;return result;}));
el('reset').addEventListener('click',()=>{settingsDirty=false;void refresh();});
el('s-schedule').addEventListener('change',()=>schedulingFields('s'));el('bt-schedule').addEventListener('change',()=>schedulingFields('bt'));
function request(compare=false):BacktestRequest {
  return {start:value('bt-start'),end:value('bt-end'),initial_cash:value('bt-cash'),source:value('bt-source') as BacktestRequest['source'],strategy:value('bt-strategy') as BacktestRequest['strategy'],
    whole_lots:checked('bt-whole'),strategy_schedule:compare?'interval':value('bt-schedule') as BacktestRequest['strategy_schedule'],strategy_times:times(value('bt-times')),
    capital_profile:value('bt-capital-profile') as BacktestRequest['capital_profile'],entry_cadence:value('bt-entry-cadence') as BacktestRequest['entry_cadence'],start_time:value('bt-start-time'),end_time:value('bt-end-time'),symbols:times(value('bt-symbols')),playback_speed:value('replay-mode')==='direct'?0:Number(value('replay-speed-number')),
    decision_interval_minutes:Number(value('bt-interval')),monitor_interval_seconds:300,watch_refresh_minutes:5,
    comparison_intervals:compare?times(value('bt-compare-times')).map(Number):[],max_codex_calls:Number(value('bt-calls')),execution_slippage_bps:Number(value('bt-execution-slip')),research:{portfolio:checked('bt-research-portfolio'),entry_quality:checked('bt-research-entry'),exit_mode:value('bt-research-exit') as 'baseline'|'fixed'|'atr_trail',drawdown:value('bt-research-dd') as '0.03'|'0.04'|'0.05',cooldown:Number(value('bt-research-cooldown')),prompt_compaction:checked('bt-research-prompt')},participation:value('bt-participation')};
}
el<HTMLFormElement>('backtest-form').addEventListener('submit',e=>{e.preventDefault();void run(()=>beginReplay());});
el('bt-compare').addEventListener('click',()=>void run(()=>beginReplay(true)));
el('bt-cancel').addEventListener('click',()=>void run(()=>window.trader.cancelBacktest()));el('bt-json').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('json')));el('bt-csv').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('csv')));
el('codex-login').addEventListener('click',()=>void run(()=>window.trader.loginCodex()));
el('codex-device').addEventListener('click',()=>void run(()=>window.trader.loginCodex('device')));
el('codex-open').addEventListener('click',()=>void run(()=>window.trader.openCodexLogin()));
el('codex-test').addEventListener('click',()=>void run(async()=>{await saveCodex();return window.trader.testCodex();}));
schedulingFields('bt');void refresh().catch(()=>message('工作台連線未完成'));setInterval(()=>void refresh().catch(()=>undefined),1000);

let chartData:ChartData|undefined,chartLoading=false,chartQueued=false,chartReportId='';
let selectedSymbol='2330',chartSignature='',chartGeneration=0,chartScope='';
const chartViewport=new ChartViewport();let chartAnimation=0;
const runningEquity:{at:string;equity:string}[]=[];
function renderChart():void {
  if(!chartData)return;
  chartViewport.sync(chartData.bars.map(b=>b.at),chartScope);
  const range=el<HTMLInputElement>('chart-pan');range.max=String(chartViewport.maximum);range.value=String(chartViewport.offset);range.disabled=!chartViewport.maximum;
  range.title=range.disabled?'已顯示全部行情；可用滾輪放大後平移':'拖曳時間軸平移，更新行情時會保留目前位置';
  const count=el<HTMLSelectElement>('chart-window');count.querySelector('[data-custom]')?.remove();
  if(![...count.options].some(o=>o.value===String(chartViewport.count))){const option=document.createElement('option');option.value=String(chartViewport.count);option.textContent=chartViewport.count+' 根';option.dataset.custom='true';count.append(option);}
  count.value=String(chartViewport.count);
  el('chart-latest').classList.toggle('active',chartViewport.following);el('chart-latest').setAttribute('aria-pressed',String(chartViewport.following));
  const protections=latestState?workspaceRuntime(latestState)?.protections:[];
  const spec=protections?.find(p=>p.symbol===chartData!.symbol)?.spec;
  const levels=spec?[{price:Number(spec.stop_price),label:'停損',color:'var(--coral)'},...(spec.take_profit?[{price:Number(spec.take_profit),label:'停利',color:'var(--mint)'}]:[])]:[];
  const fills=(latestState?.replay?.fills??latestState?.backtest_result?.fills??[]).filter(f=>f.symbol===chartData!.symbol&&Date.parse(f.at)<=Date.parse(chartData!.asof));
  candles(el('market-chart'),chartData,{ma:checked('chart-ma'),bands:checked('chart-bands'),rsi:checked('chart-rsi'),
    offset:chartViewport.offset,count:chartViewport.count,priceScale:chartViewport.priceScale,levels,fills:value('chart-source')==='replay'?fills:[]});
  text('chart-name',chartData.name===chartData.symbol?chartData.symbol:chartData.name+' '+chartData.symbol);text('chart-price',fmt(chartData.bars.at(-1)?.close));
  text('chart-cutoff','資料截至 '+stamp(chartData.asof));text('chart-data-note',chartData.bars.length?`${chartViewport.offset+1}–${chartViewport.offset+chartViewport.visible} / ${fmt(chartData.bars.length)} 根`:'此範圍尚無行情');
  el('chart-data-note').title=`${chartData.interval} · ${fmt(chartData.total_points)} 筆原始行情 · 拖曳平移／滾輪縮放／拖曳右側價格軸縮放／雙擊重設`;
}
function scheduleChart():void {if(!chartAnimation)chartAnimation=requestAnimationFrame(()=>{chartAnimation=0;renderChart();});}
function chartRequest(source:ChartRequest['source']=value('chart-source') as ChartRequest['source'],symbol=value('chart-symbol')):ChartRequest {
  return {source,symbol,start:value('chart-start'),end:value('chart-end'),interval:value('chart-interval') as ChartRequest['interval']};
}
async function loadChart(source?:ChartRequest['source']):Promise<string>{
  if(chartLoading){chartQueued=true;return '正在載入最新選取的股票';}chartLoading=true;const generation=chartGeneration,reportId=latestState?.backtest_result?.id;
  try {if(source)el<HTMLSelectElement>('chart-source').value=source;const request=chartRequest();
    text('chart-hover',request.source==='replay'?'正在讀取模擬時間以前的行情…':'正在讀取真實歷史行情…');const loaded=await window.trader.chart(request);
    if(generation!==chartGeneration||JSON.stringify(request)!==JSON.stringify(chartRequest())||reportId!==latestState?.backtest_result?.id)return '行情選取已更新';
    if(request.source==='replay'&&latestState){const cutoff=workspaceCutoff(latestState);loaded.bars=loaded.bars.filter(b=>Date.parse(b.at)<=Date.parse(cutoff));loaded.asof=new Date(Math.min(Date.parse(loaded.asof),Date.parse(cutoff))).toISOString();}
    chartData=loaded;selectedSymbol=request.symbol;chartScope=JSON.stringify(request);
    renderChart();renderStockDetails();text('chart-hover',chartData.issue||chartData.source);return chartData.issue||'行情圖表已載入';
  }catch(error){text('chart-hover',error instanceof Error?error.message:'圖表資料未載入');throw error;
  }finally{chartLoading=false;if(chartQueued){chartQueued=false;void loadChart().catch(()=>undefined);}}
}
async function showStock(symbol:string):Promise<string>{
  if(selectedSymbol!==symbol){chartGeneration++;chartData=undefined;el('market-chart').replaceChildren();el('market-chart').classList.add('chart-empty');
    text('market-chart',`正在載入 ${symbol} 行情…`);text('chart-name',symbol);text('chart-price','—');}
  selectedSymbol=symbol;el<HTMLInputElement>('chart-symbol').value=symbol;markSelectedStock();renderStockDetails();return loadChart();
}
function renderStockDetails():void {
  const replay=value('chart-source')==='replay';
  const r=latestState?workspaceRuntime(latestState):null,frame=replay?latestState?.replay:undefined;
  text('detail-context',replay?'截至模擬時間':'即時行情');
  const quote=(replay?frame?.quotes:r?.quotes)?.find(q=>q.symbol===selectedSymbol&&q.odd),f=r?.features[selectedSymbol];
  const bar=chartData?.symbol===selectedSymbol?chartData.bars.at(-1):undefined;
  const account=replay?frame?.account:r?.account,position=account?.positions.find(p=>p.symbol===selectedSymbol);
  const book=el('order-book');book.replaceChildren();
  if(!replay&&quote?.bid_levels&&quote.ask_levels){for(let i=0;i<5;i++){const bid=quote.bid_levels[i],ask=quote.ask_levels[i],row=document.createElement('div');row.className='book-row';for(const v of [fmt(bid?.shares),fmt(bid?.price),fmt(ask?.price),fmt(ask?.shares)]){const span=document.createElement('span');span.textContent=v;row.append(span);}book.append(row);}}else book.textContent=replay?'歷史 K 線沒有完整零股五檔':'等待即時五檔';
  const m=r?.metadata[selectedSymbol],host=el('stock-details');host.replaceChildren();
  // Never show present-day indicators next to a historical replay cursor.
  const rows:[string,string][]=[['股票',replay?selectedSymbol:(m?.name??selectedSymbol)],['最新價',fmt(quote?.last??bar?.close)],['買價',fmt(quote?.bid)],['賣價',fmt(quote?.ask)],
    ['MA5',fmt(replay?bar?.ma5:f?.ma5??bar?.ma5)],['MA20',fmt(replay?bar?.ma20:f?.ma20??bar?.ma20)],['MA60',fmt(replay?bar?.ma60:f?.ma60??bar?.ma60)],['RSI14',fmt(replay?bar?.rsi:f?.rsi14??bar?.rsi)],
    ['支撐',fmt(replay?undefined:f?.support20)],['壓力',fmt(replay?undefined:f?.resistance20)]];
  if(position){
    const mark=Number(position.last_price),gross=(mark-Number(position.average_price))*position.shares;
    rows.push(['持有／可賣股數',`${fmt(position.shares)} / ${fmt(position.sellable)}`],['平均買價',fmt(position.average_price)],
      ['帳務估值',fmt(position.last_price)],['浮動毛損益',fmt(gross)]);
    if(position.cost_basis!==undefined)rows.push(['含買費成本',fmt(position.cost_basis)],['扣已付買費浮損益',fmt(mark*position.shares-Number(position.cost_basis))]);
    if(account){const equity=Number(account.cash)-Number(account.settlement_debits)+Number(account.settlement_credits)+account.positions.reduce((sum,p)=>sum+Number(p.last_price)*p.shares,0);
      rows.push(['單檔持倉比例',equity>0?(mark*position.shares/equity*100).toFixed(2)+'%':'—']);}
  }
  for(const [label,v] of rows){const cell=document.createElement('div');cell.className='detail-cell';const l=document.createElement('span'),n=document.createElement('strong');l.textContent=label;n.textContent=v;cell.append(l,n);host.append(cell);}
  const plan=frame?.plan??(replay?null:r?.plan),decision=plan?.analysis.decisions.find(d=>d.symbol===selectedSymbol),protection=(frame?.protections??(replay?[]:r?.protections))?.find(p=>p.symbol===selectedSymbol);
  const spec=protection?.spec??decision?.smart;const rules=plan?.analysis.screening?.entry;
  const tracking=(replay?frame?.entry_tracks:r?.entry_tracks)?.find(t=>t.plan_id===plan?.id&&t.symbol===selectedSymbol&&t.lot===(quote?.odd===false?'COMMON':'ODD'));
  const armed=protection?.trailing_armed??(!!spec?.trailing_activate&&Number(protection?.high_water)>=Number(spec.trailing_activate));
  const conditions:[string,string][]=[['方向',decision? (action[decision.action]??decision.action):plan?plan.analysis.stance:'等待有效策略'],['進場限價',decision?.limit_price??'—'],['觸發條件',decision?triggerText(decision):rules?.signal??'—'],
    ['反彈追蹤',decision?.entry_when==='REBOUND'?tracking?.armed?`低點 ${tracking.low_water} → ${thresholdHint(Number(tracking.low_water)*(1+Number(decision.rebound_fraction)))}`:'尚未跌至門檻':'—'],
    ['額外必要條件',decision?guardText(decision)||'無':'—'],['優先停損',spec?.stop_price??'—'],['固定停利',spec?.take_profit??'未啟用'],['收益目標（不觸發）',spec?.reward_target??spec?.take_profit??'—'],
    ['追蹤啟動價',spec?.trailing_activate?thresholdHint(Number(spec.trailing_activate)):'—'],['高點回落',spec?.trailing_fraction?`${pct(spec.trailing_fraction)} · ${armed?'已啟動':'待啟動'}`:'—'],
    ['移動退場價',armed&&spec?.trailing_fraction?`高點 ${protection!.high_water} → ${thresholdHint(Number(protection!.high_water)*(1-Number(spec.trailing_fraction)))}`:'—']];
  conditions.push(['有效保護底線',protection?.protected_floor?thresholdHint(Number(protection.protected_floor)):spec?.stop_price??'—'],['已觀測最高價',protection?.high_water??'—'],
    ['費稅保本價',protection?.break_even_price?`${thresholdHint(Number(protection.break_even_price))} · ${protection.break_even_armed?'已啟動':'待啟動'}`:'—'],
    ['追蹤期限',tracking?.expires_at?stamp(tracking.expires_at):'—']);
  const state=(replay?frame?.decisions:r?.decisions)?.find(x=>x.symbol===selectedSymbol);
  if(state)conditions.push(['目前狀態',action[state.state]??state.state],['執行／等待原因',state.reason]);
  if(position&&!position.sellable)conditions.push(['可賣限制','今日新增股數不可當日賣出']);
  conditionList('stock-conditions',conditions,decision?.reason??(rules?'符合規則後，再由 Codex 按目前現金確認股數，送單前重新核對風控。':'等待 Codex 分析或模擬策略'));
}
function conditionList(id:string,rows:[string,string][],note=''):void {
  const host=el(id);host.replaceChildren();for(const [label,v] of rows){const row=document.createElement('div');row.className='condition-item';const l=document.createElement('span'),n=document.createElement('strong');l.textContent=label;n.textContent=v;row.append(l,n);host.append(row);}if(note){const p=document.createElement('p');p.textContent=note;host.append(p);}
}
function renderExtras(state:DesktopState):void {
  const diagnostic=state.broker_diagnostics;
  text('diagnostic-status',diagnostic?.startup?`${state.connection.status}${diagnostic.startup.issue&&!diagnostic.workspace?.issue&&!state.connection.status.includes(diagnostic.startup.issue)?' · '+diagnostic.startup.issue:''}`:diagnostic?`Shioaji ${diagnostic.version??'版本待確認'} · ${diagnostic.stream_connected?'行情串流已連線':'行情串流等待恢復'} · 回報快取 ${diagnostic.trade_cache??'待核對'}`:'尚未登入 Shioaji');
  text('diagnostic-workspace',diagnostic?.workspace?`${diagnostic.workspace.mode==='live'?'實盤':'模擬'}工作台 · ${diagnostic.workspace.state==='read_only'?'帳務唯讀':diagnostic.workspace.state==='ready'?'已就緒':diagnostic.workspace.state==='failed'?'初始化未完成':'正在準備'}${diagnostic.workspace.issue?'\n'+diagnostic.workspace.issue:''}`:'');
  el('workspace-retry').hidden=!diagnostic?.workspace?.issue;
  el<HTMLButtonElement>('workspace-retry').disabled=state.connection.busy||state.backtest_running;
  text('diagnostic-count',diagnostic?.health?`服務 ${diagnostic.health.status} · ${diagnostic.health.session_recovering?'正在恢復登入':diagnostic.health.token_stale?'登入已過期':'登入狀態已讀取'} · ${diagnostic.health.ca_expired===false?'CA 有效':diagnostic.health.ca_expired?'CA 已過期':'CA 狀態待核對'}`:'登入後會保留各端點的讀取狀態');
  table('diagnostic-endpoints',['端點','HTTP 讀取','最後成功','狀態與原因','重試時間'],(diagnostic?.endpoints??[]).map(e=>[`${e.stage}\n${e.endpoint}`,`${e.attempts} 次 / ${e.failures} 次失敗`,stamp(e.last_success_at),e.issue||'已取得回應',e.retry_at?stamp(e.retry_at):'—']),diagnostic?.startup?.issue||'尚未呼叫本機 API；登入後會顯示啟動與健康檢查紀錄');
  text('native-status',state.connection.status+' · '+(state.connection.credential_message??''));el<HTMLButtonElement>('connect-api').disabled=state.connection.busy;
  text('credential-state',state.connection.remembered?'設定已保存':state.connection.credential_state==='unreadable'?'設定需重新保存':!state.connection.encrypted?'系統加密待恢復':'尚未保存設定');
  el('credential-state').title=state.connection.credential_message??'';
  for(const id of ['api-key','secret-key']){el<HTMLInputElement>(id).required=!state.connection.remembered;
    el<HTMLInputElement>(id).placeholder=state.connection.remembered?'已保存，留空沿用原設定':id==='api-key'?'輸入 API Key':'輸入 Secret Key';}
  // Keep the user's choice. A transient encryption failure must not silently turn "remember" off.
  el<HTMLInputElement>('remember-keys').disabled=state.connection.busy;
  el<HTMLButtonElement>('connect-saved').disabled=!state.connection.remembered;
  const auth=state.codex_auth;
  text('codex-auth-state',auth.testing?'測試中':auth.test_state==='failed'?'連線待修復':auth.state==='ready'?(auth.test_state==='connected'?'連線成功':'已登入'):auth.state==='pending'?'登入中':auth.state==='checking'?'檢查中':'未登入');
  text('codex-login',auth.state==='ready'?'重新登入':'登入');
  el<HTMLButtonElement>('codex-login').disabled=auth.state==='pending'||auth.state==='checking'||auth.testing;
  el('codex-open').hidden=!auth.can_open;el('codex-device').hidden=auth.state==='ready'||auth.state==='pending'||auth.testing;
  el<HTMLButtonElement>('codex-test').disabled=auth.testing||auth.state==='pending'||auth.state==='checking';
  text('codex-device-code',auth.device_code?'裝置代碼：'+auth.device_code:'');el('codex-device-code').hidden=!auth.device_code;
  const scoped=workspaceRuntime(state);let events=workspaceEvents(state);
  const failure=replayView(state)?state.backtest_progress.last_error??(state.backtest_progress.phase==='FAILED'?state.backtest_progress.message:''):
    !scoped?.analyzing&&events.at(-1)?.stage==='FAILED'?events.at(-1)!.message:'';
  text('analysis-issue',failure);el('analysis-issue').hidden=!failure;el('analysis-status').title=failure;
  if(failure)text('analysis-status',/Codex/.test(failure)?'Codex 連線或分析失敗':'資料讀取未完成');
  if(replayView(state)&&!events.length){const logs=state.backtest_result?.strategy_log??[];
    events=logs.filter(log=>log.at<=workspaceCutoff(state)).slice(-25).map(log=>({at:log.at,asof:log.at,stage:log.review?'REVIEW':'DECISION',message:log.summary,model:state.backtest_result!.model,reasoning:'程式策略',context:'replay' as const}));
    if(!events.length&&scoped?.plan)events=[{at:scoped.plan.created_at,asof:state.replay!.at,stage:'DECISION',message:scoped.plan.analysis.summary,model:'快速程式策略',reasoning:'程式策略',context:'replay' as const}];}
  const stream=el('analyst-stream'),signature=JSON.stringify(events);
  if(stream.dataset.signature!==signature){stream.dataset.signature=signature;
    const before=new Map([...stream.children].map(n=>[(n as HTMLElement).dataset.eventId,n as HTMLElement]));
    const top=stream.getBoundingClientRect().top,anchor=stream.scrollTop>4?[...stream.children].find(n=>n.getBoundingClientRect().bottom>top):undefined;
    const anchorTop=anchor?.getBoundingClientRect().top;
    const cards=events.slice(-100).reverse().map(event=>{
      const key=event.id??JSON.stringify([event.asof,event.stage,event.message]),stamp=JSON.stringify(event),old=before.get(key);
      if(old?.dataset.eventSignature===stamp)return old;
      const row=analystCard(event);row.dataset.eventId=key;row.dataset.eventSignature=stamp;
      const opened=[...(old?.querySelectorAll('details')??[])].map(d=>d.open);
      row.querySelectorAll('details').forEach((d,i)=>{d.open=opened[i]??false;});return row;
    });
    const keep=new Set<Node>(cards);for(const node of [...stream.childNodes])if(!keep.has(node))node.remove();
    let cursor=stream.firstChild;for(const row of cards){if(cursor!==row)stream.insertBefore(row,cursor);cursor=row.nextSibling;}
    if(anchor&&stream.contains(anchor)&&anchorTop!==undefined)stream.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
    if(!events.length)stream.textContent=replayView(state)?'選擇 Codex 逐輪判斷並開始模擬，即可在此查看當時的分析與決策':'等待 Codex 開始分析';}
  const selected=events.filter(e=>e.stage==='MODEL').at(-1);
  const model=selected?.model??(!replayView(state)?state.codex_selection?.model:state.backtest_result?.request.strategy==='codex'?state.backtest_result.model:undefined);
  text('codex-effective-model',model?`實際模型：${model} · 推理 ${selected?.reasoning??state.codex_selection?.reasoning??'模型預設'}`:'實際模型：完成連線或首輪分析後確認');
  el('codex-model-control').title=model?`留空自動選用 ${model}`:'留空使用 Codex 官方目錄的預設模型';
  const datalist=el('codex-model-options');if(datalist.dataset.signature!==JSON.stringify(state.codex_models)){datalist.dataset.signature=JSON.stringify(state.codex_models);datalist.replaceChildren(...state.codex_models.map(model=>{const o=document.createElement('option');o.value=model;return o;}));}
  const screening=scoped?.plan?.analysis.screening;
  conditionList('screening-conditions',screening?[['最低成交額',fmt(screening.min_amount)],['量比門檻',screening.min_volume_ratio],['RSI 範圍',`${screening.rsi_min} — ${screening.rsi_max}`],['20 日報酬門檻',pct(screening.return20_min)]]:[],screening?'':'取得策略後顯示 Codex 選股門檻');
}
function analystCard(event:AnalystEvent):HTMLElement {
  const row=document.createElement('div');row.className='analyst-event';row.classList.toggle('failed',event.stage==='FAILED');
  const at=document.createElement('small'),title=document.createElement('strong');
  at.textContent='資料截至 '+stamp(event.asof)+(event.purpose==='EXECUTION'?' · 交易數量確認':'');
  title.textContent=(phase[event.stage]??event.stage)+' · '+event.model+' / '+event.reasoning;row.append(at,title);
  if(event.stage==='OUTPUT'){
    const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');
    summary.textContent='查看完整結構化回覆';body.textContent=event.message;details.append(summary,body);row.append(details);
  }else{const body=document.createElement('p');body.textContent=event.message;row.append(body);}
  if(event.details!==undefined||event.has_details){
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=event.stage==='SNAPSHOT'?'查看完整輸入快照':'查看完整結果';
    details.append(summary);let loaded=false;const scope=latestState&&replayView(latestState)?'replay':'runtime';
    details.addEventListener('toggle',()=>{if(details.open&&!loaded){loaded=true;const body=document.createElement('pre');body.textContent='正在載入完整內容…';details.append(body);
      const read=event.details!==undefined?Promise.resolve(event.details):event.id?window.trader.analystDetail(scope,event.id):Promise.resolve(null);
      void read.then(data=>{body.textContent=JSON.stringify(data,null,2);},()=>{body.textContent='載入未完成，可從完整紀錄重新檢視';loaded=false;});}});row.append(details);
  }
  return row;
}
let fullAnalystHistory:AnalystEvent[]=[],historyScope:'runtime'|'replay'='runtime';
function renderAnalystHistory():void {
  const query=value('analyst-history-filter').trim().toLowerCase(),filtered=fullAnalystHistory.filter(e=>!query||[e.message,e.model,e.stage,phase[e.stage],e.asof].join(' ').toLowerCase().includes(query));
  el('analyst-history-records').replaceChildren(...filtered.map(analystCard));
  text('analyst-history-count',`${filtered.length} / ${fullAnalystHistory.length} 筆`);
}
async function loadAnalystHistory():Promise<void>{fullAnalystHistory=await window.trader.analystHistory(historyScope);renderAnalystHistory();}
el('analyst-history-open').addEventListener('click',()=>void run(async()=>{
  historyScope=latestState&&replayView(latestState)?'replay':'runtime';await loadAnalystHistory();el<HTMLDialogElement>('analyst-history-dialog').showModal();return '已載入完整 Codex 紀錄';
}));
el('analyst-history-refresh').addEventListener('click',()=>void run(async()=>{await loadAnalystHistory();return '紀錄已更新';}));
el('analyst-history-filter').addEventListener('input',renderAnalystHistory);
el('analyst-history-export').addEventListener('click',()=>void run(()=>window.trader.exportAnalystHistory(historyScope)));
let playbackClock:ReplayClockState|undefined;
function receiveClock(clock:ReplayClockState):void {
  if(!playbackClock||clock.sampled_at>=playbackClock.sampled_at)playbackClock=clock;
}
window.trader.onReplayClock(receiveClock);
function paintReplayTime():void {
  if(latestState?.backtest_progress.running&&replayView(latestState)&&playbackClock?.at){
    text('replay-time',new Date(replayDisplayTime(playbackClock)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}));
    el('replay-time').dataset.at=replayDisplayTime(playbackClock);
  }
  requestAnimationFrame(paintReplayTime);
}
requestAnimationFrame(paintReplayTime);
function renderReplay(state:DesktopState):void {
  const frame=state.replay,p=state.backtest_progress,r=state.backtest_result;
  if(state.replay_clock)receiveClock(state.replay_clock);
  el('replay-time').dataset.at=p.running&&playbackClock?.at?replayDisplayTime(playbackClock):frame?.at??r?.asof??'';
  text('replay-time',p.running&&playbackClock?.at?new Date(replayDisplayTime(playbackClock)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):frame?new Date(frame.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):r?stamp(r.asof):'尚未開始模擬');
  text('replay-pnl',frame?'損益 NT$ '+fmt(frame.net_pnl):r?'損益 NT$ '+fmt(r.metrics.net_pnl):'—');
  text('replay-pause',state.replay_paused?'▶ 繼續':'Ⅱ 暫停');el<HTMLButtonElement>('replay-pause').disabled=!p.running;el<HTMLButtonElement>('replay-step').disabled=!p.running;
  text('replay-next',p.running?(state.replay_paused?'步驟完成後暫停 · ':'')+(['ANALYSIS','REVIEW','SIZING'].includes(p.phase)?'等待 Codex 完成':p.next_event_at?'下次檢查／Codex '+stamp(p.next_event_at):p.message):'每一步完成後才前進');
  el('replay-next').title=p.message;
  const stages=['SNAPSHOT','ANALYSIS','ACTIVATION','MONITOR','SIZING','RECONCILE'],index=stages.indexOf(p.phase==='SIZE_CONFIRM'?'RECONCILE':p.phase);
  for(const node of document.querySelectorAll<HTMLElement>('[data-replay-stage]')){const n=stages.indexOf(node.dataset.replayStage!);node.classList.toggle('active',p.running&&n===index);node.classList.toggle('done',p.phase==='COMPLETED'||p.running&&(p.phase==='REPLAY'||n<index));}
  if(!frame&&!r)table('bt-fills',['時間','股票','方向','股數','價格'],[],p.running?'正在準備歷史行情與獨立模擬帳戶':'開始模擬後顯示成交；Codex 選股與條件會依排程完整執行');
  if(p.running&&frame)table('bt-fills',['台北時間','股票','方向','股數','價格','手續費 / 稅'],frame.fills.slice(-40).reverse().map(f=>[stamp(f.at),f.symbol,action[f.action]??f.action,f.shares,fmt(f.price),`${fmt(f.fee)} / ${fmt(f.tax)}`]),'等待條件觸發與下一筆價格事件成交');
  if(frame&&p.running){if(!runningEquity.length||Date.parse(frame.at)<Date.parse(runningEquity.at(-1)!.at))runningEquity.length=0;
    if(runningEquity.at(-1)?.at!==frame.at){const a=frame.account;runningEquity.push({at:frame.at,equity:String(Number(a.cash)-Number(a.settlement_debits)+Number(a.settlement_credits)+a.positions.reduce((sum,x)=>sum+Number(x.last_price)*x.shares,0))});}
    equityChart(el('equity-chart'),runningEquity,Number(value('bt-cash')));}
  if(replayView(state)&&(frame||r)){
    if(r&&!p.running&&chartReportId!==r.id){chartReportId=r.id;chartGeneration++;chartSignature='';chartData=undefined;
      el<HTMLInputElement>('chart-start').value=r.request.start;el<HTMLInputElement>('chart-end').value=r.request.end;}
    const symbols=state.replay_symbols;
    if(symbols.length&&!symbols.some(s=>s.symbol===selectedSymbol)){selectedSymbol=symbols[0]!.symbol;el<HTMLInputElement>('chart-symbol').value=selectedSymbol;}
    const cutoff=frame?.at??r?.asof??'', key=cutoff+':'+selectedSymbol+':'+value('chart-interval')+':'+(r?.id??'running');
    if(key!==chartSignature&&!chartLoading){void loadChart('replay').then(()=>{chartSignature=key;}).catch(()=>undefined);}
  }
}
function refreshLivePrice(state:DesktopState):void {
  if(!chartData||value('chart-source')!=='live')return;
  const q=state.runtime?.quotes.find(q=>q.symbol===chartData!.symbol&&q.odd);if(!q||q.simulated)return;
  text('chart-price',fmt(q.last));
  // Streaming quotes update the current bar; historical HTTP data is never polled.
  const last=chartData.bars.at(-1);if(!last||Date.parse(q.trade_at)<=Date.parse(last.at))return;
  const day=new Date(q.trade_at).toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'});
  if(day>value('chart-end')||day<value('chart-start'))return;
  const period=chartData.interval==='1d'?86400000:Number(chartData.interval.slice(0,-1))*60000;
  const same=chartData.interval==='1d'?new Date(last.at).toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'})===day:Math.ceil(Date.parse(last.at)/period)===Math.ceil(Date.parse(q.trade_at)/period);
  if(same){last.close=Number(q.last);last.high=Math.max(last.high,last.close);last.low=Math.min(last.low,last.close);last.at=q.trade_at;}
  else chartData.bars.push({at:q.trade_at,open:Number(q.last),high:Number(q.last),low:Number(q.last),close:Number(q.last),volume:0});
  chartData.asof=q.trade_at;renderChart();
}
const dateAt=(n:number):string=>new Date(Date.now()+8*3600000+n*86400000).toISOString().slice(0,10),today=dateAt(0);
for(const id of ['bt-end','chart-end']){el<HTMLInputElement>(id).value=today;el<HTMLInputElement>(id).max=today;}
el<HTMLInputElement>('bt-start').value=dateAt(-30);el<HTMLInputElement>('bt-start').max=today;el<HTMLInputElement>('chart-start').value=dateAt(-120);el<HTMLInputElement>('chart-start').max=today;
el<HTMLFormElement>('chart-form').addEventListener('submit',e=>{e.preventDefault();void run(()=>loadChart());});
for(const id of ['chart-ma','chart-bands','chart-rsi'])el(id).addEventListener('input',renderChart);
el('chart-pan').addEventListener('input',()=>{chartViewport.move(Number(value('chart-pan')));renderChart();});
el('chart-window').addEventListener('change',()=>{chartViewport.setCount(Number(value('chart-window')));renderChart();});
el('chart-latest').addEventListener('click',()=>{chartViewport.latest();renderChart();});
el('chart-fit').addEventListener('click',()=>{chartViewport.fit();renderChart();});
el('chart-interval').addEventListener('change',()=>void run(()=>loadChart()));
const chartHost=el('market-chart');
let chartDrag:{id:number;x:number;y:number;offset:number;count:number;priceScale:number;axis:boolean}|undefined;
chartHost.addEventListener('pointerdown',event=>{if(event.button!==0||!chartData?.bars.length)return;const box=chartHost.getBoundingClientRect();
  chartDrag={id:event.pointerId,x:event.clientX,y:event.clientY,offset:chartViewport.offset,count:chartViewport.visible,priceScale:chartViewport.priceScale,axis:event.clientX>box.right-60};
  chartHost.setPointerCapture(event.pointerId);chartHost.focus({preventScroll:true});chartHost.classList.add('dragging');event.preventDefault();});
chartHost.addEventListener('pointermove',event=>{if(!chartDrag||event.pointerId!==chartDrag.id)return;
  if(chartDrag.axis){chartViewport.priceScale=chartDrag.priceScale;chartViewport.scalePrice(Math.exp((event.clientY-chartDrag.y)/140));}
  else chartViewport.move(chartDrag.offset-(event.clientX-chartDrag.x)/Math.max(1,chartHost.clientWidth-70)*chartDrag.count);
  scheduleChart();});
const endDrag=():void=>{chartDrag=undefined;chartHost.classList.remove('dragging');};
for(const event of ['pointerup','pointercancel','lostpointercapture'])chartHost.addEventListener(event,endDrag);
chartHost.addEventListener('wheel',event=>{if(!chartData?.bars.length)return;event.preventDefault();const box=chartHost.getBoundingClientRect();
  if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY))chartViewport.pan((event.deltaX||event.deltaY)/Math.max(1,box.width-70)*chartViewport.visible);
  else if(event.clientX>box.right-60)chartViewport.scalePrice(Math.exp(-Math.max(-200,Math.min(200,event.deltaY))/400));
  else chartViewport.zoom(Math.exp(Math.max(-200,Math.min(200,event.deltaY))/400),(event.clientX-box.left-10)/Math.max(1,box.width-70));
  scheduleChart();},{passive:false});
chartHost.addEventListener('dblclick',()=>{chartViewport.reset();renderChart();});
chartHost.addEventListener('keydown',event=>{if(!chartData)return;
  if(event.key==='ArrowLeft')chartViewport.pan(-Math.max(1,Math.round(chartViewport.visible/10)));
  else if(event.key==='ArrowRight')chartViewport.pan(Math.max(1,Math.round(chartViewport.visible/10)));
  else if(event.key==='+'||event.key==='=')chartViewport.zoom(.8);
  else if(event.key==='-')chartViewport.zoom(1.25);
  else if(event.key==='End')chartViewport.latest();else if(event.key==='Home')chartViewport.move(0);else return;
  event.preventDefault();renderChart();});
new ResizeObserver(scheduleChart).observe(chartHost);
el('market-chart').addEventListener('pointermove',()=>text('chart-hover',el('market-chart').dataset.hover??''));
el('replay-pause').addEventListener('click',()=>void run(()=>window.trader.replayControl(latestState?.replay_paused?'resume':'pause')));
el('replay-step').addEventListener('click',()=>void run(()=>window.trader.replayControl('step')));
function updateReplaySpeed(fromSlider=false):void {
  if(fromSlider)el<HTMLInputElement>('replay-speed-number').value=value('replay-speed');
  const speed=Number(value('replay-speed-number'));
  const direct=value('replay-mode')==='direct';
  if(!direct&&(!Number.isFinite(speed)||speed<1||speed>60)){message('加速播放限 1–60 倍',true);return;}
  el<HTMLInputElement>('replay-speed').value=String(speed);
  el<HTMLInputElement>('replay-speed').disabled=direct;el<HTMLInputElement>('replay-speed-number').disabled=direct;
  text('replay-speed-label',direct?'每 5 分鐘推進':speed+'× · 秒數連續');
  void window.trader.replaySpeed(value('replay-mode')==='direct'?0:speed).catch(error=>text('status',error instanceof Error?error.message:'倍速未更新'));
}
el('replay-speed').addEventListener('input',()=>updateReplaySpeed(true));
el('replay-speed-number').addEventListener('change',()=>updateReplaySpeed());
el('replay-mode').addEventListener('change',()=>updateReplaySpeed());
updateReplaySpeed();
el('bt-market').addEventListener('click',()=>void run(()=>window.trader.exportMarket()));
for(const id of ['codex-model-control','codex-reasoning-control','codex-instruction-control'])el(id).addEventListener('input',()=>{codexDirty=true;});
async function saveCodex():Promise<string>{
  if(!latestSettings)throw new Error('設定尚未載入');
  const next:Settings={...latestSettings,codex_model:value('codex-model-control'),codex_reasoning:value('codex-reasoning-control') as Settings['codex_reasoning'],codex_instruction:value('codex-instruction-control'),codex_enabled:true};
  const result=await window.trader.saveSettings(JSON.stringify(next));latestSettings=next;codexDirty=false;return result;
}
el('codex-save').addEventListener('click',()=>void run(saveCodex));
let connectionDirty=false;
el('connection-form').addEventListener('input',event=>{connectionDirty=true;if(event.target instanceof HTMLInputElement)event.target.dataset.saved='false';});
async function loadSavedConnection(force=false):Promise<void>{
  if(connectionDirty&&!force)return;
  const saved=await window.trader.savedConnection();if(connectionDirty&&!force)return;
  for(const [id,key] of [['api-key','api_key'],['secret-key','secret_key'],['ca-path','ca_path'],['ca-password','ca_password']] as const){
    const input=el<HTMLInputElement>(id);input.value=saved?.[key]??'';input.dataset.saved=String(!!saved?.[key]);
  }
  if(saved)el<HTMLInputElement>('remember-keys').checked=saved.remember;connectionDirty=false;
}
el('choose-ca').addEventListener('click',()=>void run(async()=>{const path=await window.trader.selectFile('ca');if(path){el<HTMLInputElement>('ca-path').value=path;connectionDirty=true;}return path?'已選取 CA 憑證':'已取消選檔';}));
el<HTMLFormElement>('connection-form').addEventListener('submit',e=>{e.preventDefault();void run(async()=>{
  el<HTMLButtonElement>('connect-api').disabled=true;
  try{const result=await window.trader.connectApi({api_key:value('api-key'),secret_key:value('secret-key'),ca_path:value('ca-path'),ca_password:value('ca-password'),remember:checked('remember-keys')});
    connectionDirty=false;await loadSavedConnection(true);
    if((await window.trader.state()).connected)el<HTMLDialogElement>('settings-dialog').close();return result;
  }finally{el<HTMLButtonElement>('connect-api').disabled=false;}
});});
el('connect-saved').addEventListener('click',()=>void run(async()=>{const result=await window.trader.connectSaved();await loadSavedConnection(true);if((await window.trader.state()).connected)el<HTMLDialogElement>('settings-dialog').close();return result;}));el('forget-keys').addEventListener('click',()=>void run(async()=>{
  const result=await window.trader.forgetCredentials();connectionDirty=false;await loadSavedConnection(true);return result;
}));

async function beginReplay(compare=false):Promise<string>{
  const form=el<HTMLFormElement>('backtest-form');if(!form.reportValidity())throw new Error('請核對模擬日期、本金與排程');
  if(value('bt-strategy')==='codex')await saveCodex();
  if(latestState?.simulation_scope==='realtime')await window.trader.simulationScope('replay');
  const result=await window.trader.backtest(request(compare));runningEquity.length=0;chartData=undefined;chartSignature='';chartGeneration++;
  chartViewport.reset();chartReportId='';
  el<HTMLInputElement>('chart-start').value=value('bt-start');el<HTMLInputElement>('chart-end').value=value('bt-end');
  text('market-chart','正在準備歷史行情');el('market-chart').classList.add('chart-empty');
  for(const id of ['bt-json','bt-csv','bt-market'])el<HTMLButtonElement>(id).disabled=true;
  el<HTMLInputElement>('chart-pan').disabled=true;
  el<HTMLDialogElement>('replay-settings-dialog').close();return result;
}
async function workspaceCommand(command:string):Promise<string>{
  if(latestState&&replayView(latestState)){
    if(command==='stop'||command==='cancel-analysis')return window.trader.cancelBacktest();
    if(command==='decide'||command==='start-auto'){
      if(latestState.backtest_running)return '模擬已在執行，Codex 會依模擬排程判斷';
      el<HTMLSelectElement>('bt-strategy').value='codex';return beginReplay();
    }
    if(command==='watch')return '監測清單會隨模擬時間與歷史策略自動更新';
  }
  if(command==='decide'||command==='start-auto')await saveCodex();
  return window.trader.command(command);
}
