import type { DesktopState,TraderBridge } from './shared.js';
import type { Settings } from '../core/models.js';
import { candles,equityChart } from './charts.js';
import type { ChartData,ChartRequest } from '../core/chart.js';
import type { BacktestRequest } from '../core/backtest.js';
declare global {interface Window {trader:TraderBridge}}
const el=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
const text=(id:string,value:unknown):void=>{const node=el(id),v=String(value??'—');if(node.textContent!==v)node.textContent=v;};
const value=(id:string):string=>el<HTMLInputElement>(id).value;
const checked=(id:string):boolean=>el<HTMLInputElement>(id).checked;
const fmt=(v:string|number|undefined):string=>v===undefined||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('zh-TW',{maximumFractionDigits:2});
const pct=(v:string):string=>fmt(Number(v)*100)+'%';
const time=(v:string|null|undefined):string=>v?new Date(v).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,hour:'2-digit',minute:'2-digit'}):'—';
const stamp=(v:string|null|undefined):string=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const phase:Record<string,string>={IDLE:'尚未執行',LOADING:'準備行情',ANALYSIS:'策略分析',REVIEW:'執行檢討',REPLAY:'模擬執行',COMPLETED:'已完成',PARTIAL:'部分完成',CANCELLED:'已停止',FAILED:'未通過'};
const action:Record<string,string>={BUY:'買進',SELL:'賣出',HOLD:'觀望',ADD:'加入',REMOVE:'移除',RETAIN:'保留監控',OBSERVE:'觀測',RETAINED:'保留監控',WAIT:'等待',BLOCKED:'風控／資格阻擋',SUBMITTED:'已送出',FILLED:'已成交',PARTIAL:'部分成交',PENDING:'委託中',CANCEL_PENDING:'撤單核對中',CANCELLED:'已撤單',REJECTED:'已拒絕',UNKNOWN:'結果待核對'};
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
    }else td.textContent=String(v);}}
  host.replaceChildren(t);
}
let messageTimer:ReturnType<typeof setTimeout>|undefined;
const message=(s:string):void=>{text('message',s);el('message').classList.add('visible');clearTimeout(messageTimer);messageTimer=setTimeout(()=>el('message').classList.remove('visible'),6000);};
async function run(operation:()=>Promise<unknown>):Promise<void>{try{message(String(await operation()??'完成'));await refresh();}
  catch(e){message(e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'操作未完成');}}
let codexDirty=false,connectionDirty=false;let latestState:DesktopState|undefined;
let settingsDirty=false,polling=false,latestSettings:Settings|undefined,renderedReport='';
function selectTab(tab:string):void {
  text('page-title',({overview:'行情總覽',simulation:'歷史模擬',strategy:'Codex 控制台',orders:'委託與持倉',settings:'連線與設定'} as Record<string,string>)[tab]??tab);
  for(const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]'))b.classList.toggle('active',b.dataset.tab===tab);
  for(const page of document.querySelectorAll<HTMLElement>('[data-page]'))page.hidden=page.dataset.page!==tab;
}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]'))b.addEventListener('click',()=>selectTab(b.dataset.tab!));
const guided:Record<string,keyof Settings>={
  's-schedule':'strategy_schedule','s-interval':'decision_interval_minutes','s-monitor':'monitor_interval_seconds','s-watch':'watch_refresh_minutes',
  's-review':'postmarket_time','s-count':'watch_max_symbols','s-misses':'watch_remove_after_scans','s-amount':'watch_min_amount',
  's-model':'codex_model','s-reasoning':'codex_reasoning','s-url':'base_url','s-account':'stock_account_index','s-cash':'demo_cash',
  's-fee':'fee_rate','s-min-fee':'minimum_fee','s-settlement':'settlement_debit_sign',
  's-quotes':'manage_quote_subscriptions','s-min-cash':'min_cash_fraction','s-order-limit':'max_order_fraction','s-symbol-limit':'max_symbol_fraction','s-loss-limit':'daily_loss_fraction',
  's-watch-auto':'auto_watchlist','s-whole':'whole_lots','s-codex':'codex_enabled','s-fee-verified':'fee_verified','s-awake':'keep_awake','s-minimized':'start_minimized',
};
function schedulingFields(prefix:'s'|'bt'):void {
  const fixed=value(prefix+'-schedule')==='fixed';el<HTMLInputElement>(prefix+'-times').disabled=!fixed;el<HTMLInputElement>(prefix+'-interval').disabled=fixed;
}
function loadSettings(s:Settings):void {
  for(const [id,key] of Object.entries(guided)){const node=el<HTMLInputElement>(id),v=s[key];
    if(typeof v==='boolean')node.checked=v;else node.value=String(v);}
  if(!codexDirty){el<HTMLInputElement>('codex-model-control').value=s.codex_model;el<HTMLSelectElement>('codex-reasoning-control').value=s.codex_reasoning;el<HTMLTextAreaElement>('codex-instruction-control').value=s.codex_instruction;}
  if(!connectionDirty)el<HTMLInputElement>('connection-url').value=s.base_url;
  el<HTMLInputElement>('s-times').value=s.strategy_times.join(',');el<HTMLSelectElement>('mode').value=s.mode;
  el<HTMLTextAreaElement>('settings').value=JSON.stringify(s,null,2);text('settings-state','已儲存');schedulingFields('s');
}
function renderRuntime(state:DesktopState):void {
  const r=state.runtime,s=latestSettings;
  text('error',state.error);text('status',state.status);text('logs',state.logs.slice(-35).join('\n'));
  text('experience',state.experience);text('codex-login-status',state.codex_login);
  if(!r||!s){text('headline','等待連線');return;}
  const labels={demo:'介面測試資料',paper:'模擬 · 真實行情',readonly:'實盤監控',live:'實盤 · 真實帳戶'};
  text('mode-badge',labels[r.mode]);el('mode-badge').classList.toggle('live',r.mode==='live');
  const valid=r.plan&&Date.parse(r.plan.analysis.expires_at)>Date.now();
  text('headline',!r.connected?'等待連線':r.killed?'已停止新委託':!r.auto?'監控已開啟':r.paused?'買進已暫停':!r.session?'交易時段外，持續監控':!valid?'等待有效策略':r.blocked||!r.watch.healthy?'新買進暫停，保護監控持續':'全自動偵測中');
  text('runtime-note',r.mode==='demo'?'虛構行情與模擬資金；日期區間測試可隨時執行。':r.mode==='readonly'?'帳戶核對模式；確認現金、交割與可賣量後再切換。':
    r.auto?'依策略條件執行；每筆委託都會重新檢查帳戶、行情與風控。':'準備好後按「啟動全自動」，依有效策略執行。');
  const a=r.account;
  if(a){const stocks=a.positions.reduce((sum,p)=>sum+Number(p.last_price)*p.shares,0);
    text('equity',fmt(Number(a.cash)-Number(a.settlement_debits)+Number(a.settlement_credits)+stocks));
    const reserves=a.orders.filter(o=>o.action==='BUY'&&!['FILLED','CANCELLED','REJECTED'].includes(o.status))
      .reduce((sum,o)=>sum+Number(o.limit_price)*(o.shares-o.filled)+Math.max(Number(s.minimum_fee),Math.ceil(Number(o.limit_price)*(o.shares-o.filled)*Number(s.fee_rate))),0);
    text('cash',fmt(Math.max(0,Number(a.cash)-Number(a.settlement_debits)-reserves)));
    text('cash-detail',`股票市值 ${fmt(stocks)} · 今日買進 ${a.daily_buy_count} 筆`);
    text('settlement-detail',`待付 ${fmt(a.settlement_debits)} · 待收 ${fmt(a.settlement_credits)}`);
    text('data-status',`${a.complete?'帳戶已核對':'帳戶未確認'} · ${stamp(a.asof)}`);
  }else{text('equity','—');text('cash','—');text('data-status','等待帳戶核對');}
  text('watch-count',r.watch.entries.filter(w=>w.state==='OBSERVE').length);text('watch-detail',r.watch.issue||`保留監控 ${r.watch.entries.filter(w=>w.state==='RETAINED').length} 檔`);
  text('next-strategy',time(r.next_strategy_at));text('next-detail',r.next_strategy_at?`${stamp(r.next_strategy_at)} · 台北`:'等待已驗證交易日');
  text('schedule-strategy',s.strategy_schedule==='fixed'?s.strategy_times.join(' / '):s.decision_interval_minutes+' 分鐘');text('analysis-status',r.analysis_status);
  text('schedule-monitor',s.monitor_interval_seconds+' 秒');text('monitor-status',`最近偵測 ${stamp(r.last_monitor_at)}`);
  text('schedule-watch',s.watch_refresh_minutes+' 分鐘');text('scan-status',r.scanning?'正在更新觀測':`最近更新 ${stamp(r.watch.asof)}`);
  el('live-authorization').hidden=r.mode!=='live';
  el('connection-dot').classList.toggle('connected',r.connected);text('sidebar-connection',r.connected?'Shioaji 已連線':'等待 Shioaji 連線');
  text('wall-clock',new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}));
  const rows=r.watch.entries.map(w=>{const q=r.quotes.find(q=>q.symbol===w.symbol&&q.odd),d=r.decisions.find(d=>d.symbol===w.symbol);
    const detail=d?.reason??(!w.eligible?w.reason:!valid?'等待有效策略':!r.auto?'等待啟動自動交易':'等待價格條件或下一輪個股決策');
    const decision=r.plan?.analysis.decisions.find(d=>d.symbol===w.symbol),protection=r.protections.find(p=>p.symbol===w.symbol);
    return [{label:w.symbol,chartSymbol:w.symbol},w.name,q?fmt(q.last):'—',decision?.trigger_price&&Number(decision.trigger_price)>0?decision.trigger_price:'—',protection?.spec.stop_price??decision?.smart?.stop_price??'—',protection?.spec.take_profit??decision?.smart?.take_profit??'—',d?action[d.state]??d.state:action[w.state],detail] as Cell[];});
  table('overview-watch',['股票','名稱','零股現價','進場條件','停損','停利','執行狀態','判斷原因'],rows,'連接 API 並更新觀測後，會顯示動態選股結果');
  table('watchlist',['股票','名稱','來源','資格','評分','原因'],r.watch.entries.map(w=>[w.symbol,w.name,w.source==='CODEX'?'Codex 候選':'動態掃描',w.eligible?'已確認':action[w.state]??w.state,w.score,w.reason]));
  table('watch-changes',['台北時間','股票','動作','原因'],r.watch.changes.slice(-20).reverse().map(c=>[stamp(c.at),c.symbol,action[c.action]??c.action,c.reason]));
  table('positions',['股票','持有 / 可賣','均價 / 現價','停損 / 停利'],(a?.positions??[]).map(p=>{const protection=r.protections.find(x=>x.symbol===p.symbol);
    return [p.symbol,`${fmt(p.shares)} / ${fmt(p.sellable)}`,`${fmt(p.average_price)} / ${fmt(p.last_price)}`,
      protection?`${protection.spec.stop_price} / ${protection.spec.take_profit??'—'}`:'等待策略提供保護'];}),'目前無持倉');
  table('orders',['股票 / 方向','成交 / 股數','限價','狀態',''],r.orders.map(o=>[`${o.symbol} ${action[o.action]}`,`${o.filled} / ${o.shares}`,o.limit_price,action[o.status]??o.status,
    o.purpose==='EXTERNAL'?'外部委託':{label:'撤單核對',command:'cancel '+o.local_id}]),'目前無未完成委託');
  const stance={BUY_ALLOWED:'允許條件買進',HOLD_ONLY:'保留現金／觀望',REDUCE:'減碼優先'};
  text('strategy-stance',r.plan?stance[r.plan.analysis.stance]:'等待第一輪策略');text('strategy-summary',r.plan?.analysis.summary??'取得有效策略後，程式會依條件執行。');
  text('strategy-expiry',r.plan?`有效至 ${stamp(r.plan.analysis.expires_at)}${valid?'':' · 已到期'}`:'');
  const rule=r.plan?.analysis.screening?.entry;
  text('rule-summary',rule?`自動規則 ${rule.signal} · 每檔配置 ${pct(rule.allocation_fraction)} · 停損 ${pct(rule.stop_fraction)} · 停利 ${pct(rule.take_profit_fraction)} · 移動停損 ${rule.trailing_fraction?pct(rule.trailing_fraction):'關閉'}`:'依 Codex 個股決策執行；新加入股票等待授權條件');
  table('decisions',['股票','方向','股數','限價','觸發','策略理由'],(r.plan?.analysis.decisions??[]).map(d=>[d.symbol,action[d.action]??d.action,d.shares,d.limit_price,
    d.entry_when==='IMMEDIATE'?'條件檢查後':`${d.entry_when==='BELOW'?'低於':'高於'} ${d.trigger_price}`,d.reason]),'本輪無個股委託；可能使用規則選股或全部觀望');
  text('watch-policy',`最多 ${s.watch_max_symbols} 檔 · 連續 ${s.watch_remove_after_scans} 次不符移除`);
  text('connection-status',`${r.connected?'已連線':'等待連線'} · ${s.base_url} · 每種模式獨立保存`);
  text('risk-summary',`現金保留 ${pct(s.min_cash_fraction)} · 單筆 ${pct(s.max_order_fraction)} · 單檔 ${pct(s.max_symbol_fraction)} · 日損失 ${pct(s.daily_loss_fraction)} 停止新買進`);
}
function renderBacktest(state:DesktopState):void {
  const p=state.backtest_progress,r=state.backtest_result;renderReplay(state);
  text('bt-progress-title',phase[p.phase]??p.phase);text('bt-progress-detail',`${p.total_runs&&p.total_runs>1?`第 ${p.run} / ${p.total_runs} 組 · `:''}${p.day} · Codex ${p.codex_calls}`);
  text('bt-progress-message',p.message);el<HTMLProgressElement>('bt-progress').value=p.total_points?Math.round(p.points/p.total_points*100):0;
  el<HTMLButtonElement>('bt-run').disabled=p.running;el<HTMLButtonElement>('bt-compare').disabled=p.running;el<HTMLButtonElement>('bt-cancel').disabled=!p.running;
  el('bt-result').hidden=!r;el<HTMLButtonElement>('bt-json').disabled=!r;el<HTMLButtonElement>('bt-csv').disabled=!r;
  if(!r){table('bt-history',['日期區間','策略排程','淨損益','報酬','結果',''],state.backtest_history.map(h=>[`${h.start} — ${h.end}`,h.schedule,fmt(h.net_pnl),fmt(h.return_pct)+'%',phase[h.status]??h.status,{label:'檢視',report:h.id}]));return;}
  table('bt-history',['日期區間','策略排程','偵測','淨損益','報酬','回撤','呼叫','結果',''],state.backtest_history.map(h=>[`${h.start} — ${h.end}`,h.schedule,`${h.monitor_seconds} 秒`,fmt(h.net_pnl),fmt(h.return_pct)+'%',fmt(h.drawdown_pct)+'%',h.calls,
    (h.synthetic?'虛構 · ':'')+(phase[h.status]??h.status),{label:h.id===r.id?'檢視中':'檢視',report:h.id}]));
  if(renderedReport===r.id)return;renderedReport=r.id;const m=r.metrics;
  text('bt-result-title',`${r.synthetic?'虛構行情流程測試':'歷史模擬'} · ${r.request.start} 至 ${r.request.end} · ${phase[r.status]??r.status}`);
  text('bt-pnl',fmt(m.net_pnl));el('bt-pnl').className=Number(m.net_pnl)>=0?'positive':'negative';text('bt-return',`報酬 ${fmt(m.return_pct)}% · 已實現 ${fmt(m.realized_pnl)}`);
  text('bt-drawdown',fmt(m.max_drawdown_pct)+'%');text('bt-cost',`手續費 ${fmt(m.fees)} · 稅 ${fmt(m.taxes)}`);text('bt-filled',m.filled_orders);
  text('bt-activity',`觀測加入 ${m.watch_adds} / 移除 ${m.watch_removes} · Codex ${m.codex_calls}`);text('bt-equity',fmt(m.final_equity));
  text('bt-quality',`行情 ${r.quality.covered_sessions}/${r.quality.sessions} 日 · 有效策略 ${r.quality.successful_strategies}/${r.quality.strategy_slots}`);
  table('bt-fills',['台北時間','股票','方向','股數','價格','手續費 / 稅','已實現損益'],r.fills.slice().reverse().map(f=>[stamp(f.at),f.symbol,action[f.action]??f.action,f.shares,fmt(f.price),`${fmt(f.fee)} / ${fmt(f.tax)}`,f.realized_pnl===null?'—':fmt(f.realized_pnl)]),'本次無成交；請核對策略、資料與風控紀錄');
  table('bt-daily',['日期','淨值','現金','待收交割'],r.daily_equity.map(d=>[d.day,fmt(d.equity),fmt(d.cash),fmt(d.settlement_credits)]));
  text('bt-strategy-log',r.strategy_log.map(s=>`${stamp(s.at)} ${s.review?'檢討':'策略'} ${s.stance}\n${s.summary}`).join('\n\n'));
  text('bt-limitations',[`暖機不足股票：${r.quality.insufficient_symbols.join('、')||'無'}`,`缺行情交易日：${r.quality.missing_sessions.join('、')||'無'}`,...r.limitations].join('\n'));
  text('backtest',state.backtest);
  equityChart(el('equity-chart'),r.timeline??r.daily_equity.map(d=>({at:d.asof,equity:d.equity})),Number(r.metrics.initial_cash));
}
async function refresh():Promise<void>{if(polling)return;polling=true;
  try{const state=await window.trader.state();latestState=state;latestSettings=JSON.parse(state.settings) as Settings;if(!settingsDirty)loadSettings(latestSettings);renderRuntime(state);renderBacktest(state);renderExtras(state);refreshLivePrice(state);renderStockDetails();}
  finally{polling=false;}}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-command]'))b.addEventListener('click',()=>void run(()=>window.trader.command(b.dataset.command!)));
el<HTMLFormElement>('command-form').addEventListener('submit',e=>{e.preventDefault();const command=value('command');el<HTMLInputElement>('command').value='';void run(()=>window.trader.command(command));});
el('hide').addEventListener('click',()=>void run(()=>window.trader.minimize()));el('exit').addEventListener('click',()=>void run(()=>window.trader.exit()));
el('switch').addEventListener('click',()=>void run(async()=>{const result=await window.trader.configure(value('mode'));settingsDirty=false;return result;}));
el('authorize').addEventListener('click',()=>void run(()=>window.trader.authorizeLive(value('ack'))));
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
    start_time:value('bt-start-time'),end_time:value('bt-end-time'),symbols:times(value('bt-symbols')),playback_speed:Number(value('replay-speed')),
    decision_interval_minutes:Number(value('bt-interval')),monitor_interval_seconds:Number(value('bt-monitor')),watch_refresh_minutes:Number(value('bt-watch')),
    comparison_intervals:compare?times(value('bt-compare-times')).map(Number):[],max_codex_calls:Number(value('bt-calls')),participation:value('bt-participation')};
}
el<HTMLFormElement>('backtest-form').addEventListener('submit',e=>{e.preventDefault();void run(()=>window.trader.backtest(request()));});
el('bt-compare').addEventListener('click',()=>{if(el<HTMLFormElement>('backtest-form').reportValidity())void run(()=>window.trader.backtest(request(true)));});
el('bt-cancel').addEventListener('click',()=>void run(()=>window.trader.cancelBacktest()));el('bt-json').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('json')));el('bt-csv').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('csv')));
el('codex-login').addEventListener('click',()=>void run(()=>window.trader.loginCodex()));
schedulingFields('bt');void refresh().catch(()=>message('工作台連線未完成'));setInterval(()=>void refresh().catch(()=>undefined),1000);

let chartData:ChartData|undefined,simData:ChartData|undefined,chartLoading=false,simLoading=false;
let selectedSymbol='2330',simSignature='' ;
const runningEquity:{at:string;equity:string}[]=[];
function renderChart():void {
  if(!chartData)return;
  const protections=value('chart-source')==='replay'?latestState?.replay?.protections:latestState?.runtime?.protections;
  const spec=protections?.find(p=>p.symbol===chartData!.symbol)?.spec;
  const levels=spec?[{price:Number(spec.stop_price),label:'停損',color:'#ff7d86'},...(spec.take_profit?[{price:Number(spec.take_profit),label:'停利',color:'#44d6aa'}]:[])]:[];
  const fills=latestState?.backtest_result?.fills.filter(f=>f.symbol===chartData!.symbol)??latestState?.replay?.fills.filter(f=>f.symbol===chartData!.symbol)??[];
  candles(el('market-chart'),chartData,{ma:checked('chart-ma'),bands:checked('chart-bands'),rsi:checked('chart-rsi'),
    offset:Number(value('chart-pan')),count:Number(value('chart-window')),levels,fills:value('chart-source')==='replay'?fills:[]});
  text('chart-name',chartData.name+' '+chartData.symbol);text('chart-price',fmt(chartData.bars.at(-1)?.close));
  text('chart-cutoff','資料截至 '+stamp(chartData.asof));text('chart-data-note',`${chartData.interval} · ${fmt(chartData.total_points)} 筆原始行情 / ${fmt(chartData.bars.length)} 根 K 線`);
}
function chartRequest(source:ChartRequest['source']=value('chart-source') as ChartRequest['source'],symbol=value('chart-symbol')):ChartRequest {
  return {source,symbol,start:value('chart-start'),end:value('chart-end'),interval:value('chart-interval') as ChartRequest['interval']};
}
async function loadChart(source?:ChartRequest['source']):Promise<string>{
  if(chartLoading)return '行情圖表正在載入';chartLoading=true;
  try {if(source)el<HTMLSelectElement>('chart-source').value=source;const request=chartRequest();
    text('chart-hover','正在讀取真實歷史行情…');chartData=await window.trader.chart(request);selectedSymbol=request.symbol;
    const range=el<HTMLInputElement>('chart-pan');range.max=String(Math.max(0,chartData.bars.length-Number(value('chart-window'))));range.value=range.max;
    renderChart();renderStockDetails();text('chart-hover',chartData.issue||chartData.source);return chartData.issue||'行情圖表已載入';
  }finally{chartLoading=false;}
}
async function showStock(symbol:string):Promise<string>{selectedSymbol=symbol;el<HTMLInputElement>('chart-symbol').value=symbol;selectTab('overview');return loadChart();}
function renderStockDetails():void {
  const r=latestState?.runtime,frame=value('chart-source')==='replay'?latestState?.replay:undefined;
  const quote=(frame?.quotes??r?.quotes)?.find(q=>q.symbol===selectedSymbol&&q.odd),f=r?.features[selectedSymbol];
  const replay=value('chart-source')==='replay';
  const bar=chartData?.symbol===selectedSymbol?chartData.bars.at(-1):undefined;
  const book=el('order-book');book.replaceChildren();
  if(!replay&&quote?.bid_levels&&quote.ask_levels){for(let i=0;i<5;i++){const bid=quote.bid_levels[i],ask=quote.ask_levels[i],row=document.createElement('div');row.className='book-row';for(const v of [fmt(bid?.shares),fmt(bid?.price),fmt(ask?.price),fmt(ask?.shares)]){const span=document.createElement('span');span.textContent=v;row.append(span);}book.append(row);}}else book.textContent=replay?'歷史 K 線沒有完整零股五檔':'等待即時五檔';
  const m=r?.metadata[selectedSymbol],host=el('stock-details');host.replaceChildren();
  // Never show present-day indicators next to a historical replay cursor.
  const rows:[string,string][]=[['股票',replay?selectedSymbol:(m?.name??selectedSymbol)],['最新價',fmt(quote?.last??bar?.close)],['買價',fmt(quote?.bid)],['賣價',fmt(quote?.ask)],
    ['MA5',fmt(replay?bar?.ma5:f?.ma5??bar?.ma5)],['MA20',fmt(replay?bar?.ma20:f?.ma20??bar?.ma20)],['MA60',fmt(replay?bar?.ma60:f?.ma60??bar?.ma60)],['RSI14',fmt(replay?bar?.rsi:f?.rsi14??bar?.rsi)],
    ['支撐',fmt(replay?undefined:f?.support20)],['壓力',fmt(replay?undefined:f?.resistance20)]];
  for(const [label,v] of rows){const cell=document.createElement('div');cell.className='detail-cell';const l=document.createElement('span'),n=document.createElement('strong');l.textContent=label;n.textContent=v;cell.append(l,n);host.append(cell);}
  const plan=frame?.plan??(replay?null:r?.plan),decision=plan?.analysis.decisions.find(d=>d.symbol===selectedSymbol),protection=(frame?.protections??(replay?[]:r?.protections))?.find(p=>p.symbol===selectedSymbol);
  const spec=protection?.spec??decision?.smart;const rules=plan?.analysis.screening?.entry;
  const conditions:[string,string][]=[['方向',decision? (action[decision.action]??decision.action):plan?plan.analysis.stance:'等待有效策略'],['進場限價',decision?.limit_price??'—'],['觸發條件',decision?.entry_when==='IMMEDIATE'?'即時檢查':decision?`${decision.entry_when==='BELOW'?'低於':'高於'} ${decision.trigger_price}`:rules?.signal??'—'],
    ['停損',spec?.stop_price??'—'],['停利',spec?.take_profit??'—'],['移動停損',spec?.trailing_fraction?pct(spec.trailing_fraction):rules?.trailing_fraction?pct(rules.trailing_fraction):'—']];
  conditionList('stock-conditions',conditions,decision?.reason??(rules?'符合規則後，由程式計算價格與股數，再驗證硬性風控。':'等待 Codex 分析或模擬策略'));
}
function conditionList(id:string,rows:[string,string][],note=''):void {
  const host=el(id);host.replaceChildren();for(const [label,v] of rows){const row=document.createElement('div');row.className='condition-item';const l=document.createElement('span'),n=document.createElement('strong');l.textContent=label;n.textContent=v;row.append(l,n);host.append(row);}if(note){const p=document.createElement('p');p.textContent=note;host.append(p);}
}
function renderExtras(state:DesktopState):void {
  text('native-status',state.connection.status);text('credential-state',state.connection.remembered?'已使用系統加密記住設定':'未記住金鑰');
  el<HTMLInputElement>('remember-keys').disabled=!state.connection.encrypted;
  el<HTMLButtonElement>('connect-saved').disabled=!state.connection.remembered;
  const stream=el('analyst-stream'),signature=JSON.stringify(state.analyst_events);
  if(stream.dataset.signature!==signature){stream.dataset.signature=signature;stream.replaceChildren();
    for(const event of state.analyst_events.slice(-25).reverse()){const row=document.createElement('div');row.className='analyst-event';
      const at=document.createElement('small'),title=document.createElement('strong'),p=document.createElement('p');at.textContent=stamp(event.at);title.textContent=event.stage+' · '+event.model+' / '+event.reasoning;p.textContent=event.message;row.append(at,title,p);stream.append(row);}
    if(!state.analyst_events.length)stream.textContent='等待 Codex 開始分析';}
  const datalist=el('codex-model-options');if(datalist.dataset.signature!==JSON.stringify(state.codex_models)){datalist.dataset.signature=JSON.stringify(state.codex_models);datalist.replaceChildren(...state.codex_models.map(model=>{const o=document.createElement('option');o.value=model;return o;}));}
  const screening=state.runtime?.plan?.analysis.screening;
  conditionList('screening-conditions',screening?[['最低成交額',fmt(screening.min_amount)],['量比門檻',screening.min_volume_ratio],['RSI 範圍',`${screening.rsi_min} — ${screening.rsi_max}`],['20 日報酬門檻',pct(screening.return20_min)]]:[],screening?'':'取得策略後顯示 Codex 選股門檻');
}
function renderReplay(state:DesktopState):void {
  const frame=state.replay,p=state.backtest_progress,r=state.backtest_result;
  text('replay-time',frame?new Date(frame.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):r?stamp(r.asof):'尚未開始模擬');
  text('sim-cutoff',frame?'截至 '+stamp(frame.at):r?'截至 '+stamp(r.asof):'截至模擬時間');
  text('replay-pnl',frame?'損益 NT$ '+fmt(frame.net_pnl):r?'損益 NT$ '+fmt(r.metrics.net_pnl):'—');
  text('replay-pause',state.replay_paused?'▶ 繼續':'Ⅱ 暫停');el<HTMLButtonElement>('replay-pause').disabled=!p.running;el<HTMLButtonElement>('replay-step').disabled=!p.running;
  if(frame&&p.running){if(!runningEquity.length||Date.parse(frame.at)<Date.parse(runningEquity.at(-1)!.at))runningEquity.length=0;
    if(runningEquity.at(-1)?.at!==frame.at){const a=frame.account;runningEquity.push({at:frame.at,equity:String(Number(a.cash)-Number(a.settlement_debits)+Number(a.settlement_credits)+a.positions.reduce((sum,x)=>sum+Number(x.last_price)*x.shares,0))});}
    equityChart(el('equity-chart'),runningEquity,Number(value('bt-cash')));}
  const symbols=state.replay_symbols,select=el<HTMLSelectElement>('sim-symbol'),signature=JSON.stringify(symbols);
  if(select.dataset.signature!==signature){const selected=select.value;select.dataset.signature=signature;select.replaceChildren(...symbols.map(s=>{const o=document.createElement('option');o.value=s.symbol;o.textContent=s.symbol+' '+s.name;return o;}));if(symbols.some(s=>s.symbol===selected))select.value=selected;}
  table('sim-watch',['模擬股票','名稱','已知現價','狀態','條件／原因'],(frame?.watch.entries??[]).map(w=>[w.symbol,w.name,fmt(frame?.quotes.find(q=>q.symbol===w.symbol&&q.odd)?.last),action[w.state]??w.state,w.reason]),'模擬開始後會顯示當時監測的股票');
  const simKey=(frame?.at??r?.asof??'')+':'+select.value;
  if(select.value&&simKey!==simSignature&&(p.running||!!r)) {simSignature=simKey;void loadSimChart().catch(()=>undefined);}
}
async function loadSimChart():Promise<void>{
  if(simLoading||!value('sim-symbol'))return;simLoading=true;
  try {const r=latestState?.backtest_result;simData=await window.trader.chart({source:'replay',symbol:value('sim-symbol'),start:r?.request.start??value('bt-start'),end:r?.request.end??value('bt-end'),interval:'15m'});
    candles(el('sim-chart'),simData,{ma:true,bands:true,rsi:false,offset:Math.max(0,simData.bars.length-200),count:200,
      levels:[],fills:(latestState?.replay?.fills??r?.fills??[]).filter(f=>f.symbol===simData!.symbol)});
  }finally{simLoading=false;}
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
for(const id of ['chart-ma','chart-bands','chart-rsi','chart-pan'])el(id).addEventListener('input',renderChart);
el('chart-window').addEventListener('change',()=>{if(chartData){el<HTMLInputElement>('chart-pan').max=String(Math.max(0,chartData.bars.length-Number(value('chart-window'))));el<HTMLInputElement>('chart-pan').value=el<HTMLInputElement>('chart-pan').max;}renderChart();});
el('market-chart').addEventListener('pointermove',()=>text('chart-hover',el('market-chart').dataset.hover??''));
el('replay-pause').addEventListener('click',()=>void run(()=>window.trader.replayControl(latestState?.replay_paused?'resume':'pause')));
el('replay-step').addEventListener('click',()=>void run(()=>window.trader.replayControl('step')));
el('replay-speed').addEventListener('change',()=>void run(()=>window.trader.replaySpeed(Number(value('replay-speed')))));
el('sim-symbol').addEventListener('change',()=>void run(loadSimChart));el('sim-load').addEventListener('click',()=>void run(loadSimChart));
el('bt-market').addEventListener('click',()=>void run(()=>window.trader.exportMarket()));
for(const id of ['codex-model-control','codex-reasoning-control','codex-instruction-control'])el(id).addEventListener('input',()=>{codexDirty=true;});
el('codex-save').addEventListener('click',()=>void run(async()=>{if(!latestSettings)throw new Error('設定尚未載入');
  const result=await window.trader.saveSettings(JSON.stringify({...latestSettings,codex_model:value('codex-model-control'),codex_reasoning:value('codex-reasoning-control'),codex_instruction:value('codex-instruction-control'),codex_enabled:true}));codexDirty=false;settingsDirty=false;return result;}));
el('choose-ca').addEventListener('click',()=>void run(async()=>{const path=await window.trader.selectFile('ca');if(path)el<HTMLInputElement>('ca-path').value=path;return path?'已選取 CA 憑證':'已取消選檔';}));
el('choose-cli').addEventListener('click',()=>void run(async()=>{const path=await window.trader.selectFile('cli');if(path)el<HTMLInputElement>('cli-path').value=path;return path?'已選取 Shioaji 執行檔':'已取消選檔';}));
el('connection-form').addEventListener('input',()=>{connectionDirty=true;});
el<HTMLFormElement>('connection-form').addEventListener('submit',e=>{e.preventDefault();void run(async()=>{
  if(!latestSettings)throw new Error('連線設定尚未載入');el<HTMLButtonElement>('connect-api').disabled=true;
  try{if(value('connection-url')!==latestSettings.base_url)await window.trader.saveSettings(JSON.stringify({...latestSettings,base_url:value('connection-url'),auto_execute:false}));
    return await window.trader.connectApi({api_key:value('api-key'),secret_key:value('secret-key'),ca_path:value('ca-path'),ca_password:value('ca-password'),cli_path:value('cli-path'),remember:checked('remember-keys')});
  }finally{for(const id of ['api-key','secret-key','ca-password'])el<HTMLInputElement>(id).value='';connectionDirty=false;settingsDirty=false;el<HTMLButtonElement>('connect-api').disabled=false;}
});});
el('connect-saved').addEventListener('click',()=>void run(()=>window.trader.connectSaved()));el('forget-keys').addEventListener('click',()=>void run(()=>window.trader.forgetCredentials()));
