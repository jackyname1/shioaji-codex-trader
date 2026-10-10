import type { DesktopState,TraderBridge } from './shared.js';
import type { Settings } from '../core/models.js';
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
type Cell=string|number|{label:string;command?:string;report?:string};
function table(id:string,headers:string[],rows:Cell[][],empty='目前沒有資料'):void {
  const host=el(id),signature=JSON.stringify([headers,rows,empty]);if(host.dataset.signature===signature)return;host.dataset.signature=signature;
  const t=document.createElement('table'),head=t.createTHead().insertRow();
  for(const h of headers){const cell=document.createElement('th');cell.textContent=h;head.append(cell);}
  const body=t.createTBody();
  if(!rows.length){const cell=body.insertRow().insertCell();cell.colSpan=headers.length;cell.className='empty';cell.textContent=empty;}
  for(const row of rows){const tr=body.insertRow();for(const v of row){const td=tr.insertCell();
    if(typeof v==='object'){const b=document.createElement('button');b.className='quiet';b.textContent=v.label;
      b.addEventListener('click',()=>void run(()=>v.report?window.trader.selectBacktest(v.report):window.trader.command(v.command!)));td.append(b);
    }else td.textContent=String(v);}}
  host.replaceChildren(t);
}
const message=(s:string):void=>text('message',s);
async function run(operation:()=>Promise<unknown>):Promise<void>{try{message(String(await operation()??'完成'));await refresh();}
  catch(e){message(e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'操作未完成');}}
let settingsDirty=false,polling=false,latestSettings:Settings|undefined,renderedReport='';
function selectTab(tab:string):void {
  for(const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]'))b.classList.toggle('active',b.dataset.tab===tab);
  for(const page of document.querySelectorAll<HTMLElement>('[data-page]'))page.hidden=page.dataset.page!==tab;
}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]'))b.addEventListener('click',()=>selectTab(b.dataset.tab!));
const guided:Record<string,keyof Settings>={
  's-schedule':'strategy_schedule','s-interval':'decision_interval_minutes','s-monitor':'monitor_interval_seconds','s-watch':'watch_refresh_minutes',
  's-review':'postmarket_time','s-count':'watch_max_symbols','s-misses':'watch_remove_after_scans','s-amount':'watch_min_amount',
  's-model':'codex_model','s-reasoning':'codex_reasoning','s-url':'base_url','s-account':'stock_account_index','s-cash':'demo_cash',
  's-fee':'fee_rate','s-min-fee':'minimum_fee','s-settlement':'settlement_debit_sign',
  's-quotes':'manage_quote_subscriptions',
  's-watch-auto':'auto_watchlist','s-whole':'whole_lots','s-codex':'codex_enabled','s-fee-verified':'fee_verified','s-awake':'keep_awake','s-minimized':'start_minimized',
};
function schedulingFields(prefix:'s'|'bt'):void {
  const fixed=value(prefix+'-schedule')==='fixed';el<HTMLInputElement>(prefix+'-times').disabled=!fixed;el<HTMLInputElement>(prefix+'-interval').disabled=fixed;
}
function loadSettings(s:Settings):void {
  for(const [id,key] of Object.entries(guided)){const node=el<HTMLInputElement>(id),v=s[key];
    if(typeof v==='boolean')node.checked=v;else node.value=String(v);}
  el<HTMLInputElement>('s-times').value=s.strategy_times.join(',');el<HTMLSelectElement>('mode').value=s.mode;
  el<HTMLTextAreaElement>('settings').value=JSON.stringify(s,null,2);text('settings-state','已儲存');schedulingFields('s');
}
function renderRuntime(state:DesktopState):void {
  const r=state.runtime,s=latestSettings;
  text('error',state.error);text('status',state.status);text('logs',state.logs.slice(-35).join('\n'));
  text('experience',state.experience);text('codex-login-status',state.codex_login);
  if(!r||!s){text('headline','等待連線');return;}
  const labels={demo:'DEMO / 虛構',paper:'PAPER / 模擬',readonly:'READONLY / 唯讀',live:'LIVE / 實盤'};
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
  const rows=r.watch.entries.map(w=>{const q=r.quotes.find(q=>q.symbol===w.symbol&&q.odd),d=r.decisions.find(d=>d.symbol===w.symbol);
    const detail=d?.reason??(!w.eligible?w.reason:!valid?'等待有效策略':!r.auto?'等待啟動自動交易':'等待價格條件或下一輪個股決策');
    return [w.symbol,w.name,q?fmt(q.last):'—',d?action[d.state]??d.state:action[w.state],detail] as Cell[];});
  table('overview-watch',['股票','名稱','零股現價','狀態','條件／原因'],rows,'等待觀測更新；可先執行日期區間測試');
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
  const p=state.backtest_progress,r=state.backtest_result;
  text('bt-progress-title',phase[p.phase]??p.phase);text('bt-progress-detail',`${p.total_runs&&p.total_runs>1?`第 ${p.run} / ${p.total_runs} 組 · `:''}${p.day} · Codex ${p.codex_calls}`);
  text('bt-progress-message',p.message);el<HTMLProgressElement>('bt-progress').value=p.total_points?Math.round(p.points/p.total_points*100):0;
  el<HTMLButtonElement>('bt-run').disabled=p.running;el<HTMLButtonElement>('bt-compare').disabled=p.running;el<HTMLButtonElement>('bt-cancel').disabled=!p.running;
  el('bt-result').hidden=!r;el<HTMLButtonElement>('bt-json').disabled=!r;el<HTMLButtonElement>('bt-csv').disabled=!r;
  if(!r)return;
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
}
async function refresh():Promise<void>{if(polling)return;polling=true;
  try{const state=await window.trader.state();latestSettings=JSON.parse(state.settings) as Settings;if(!settingsDirty)loadSettings(latestSettings);renderRuntime(state);renderBacktest(state);}
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
    decision_interval_minutes:Number(value('bt-interval')),monitor_interval_seconds:Number(value('bt-monitor')),watch_refresh_minutes:Number(value('bt-watch')),
    comparison_intervals:compare?times(value('bt-compare-times')).map(Number):[],max_codex_calls:Number(value('bt-calls')),participation:value('bt-participation')};
}
el<HTMLFormElement>('backtest-form').addEventListener('submit',e=>{e.preventDefault();void run(()=>window.trader.backtest(request()));});
el('bt-compare').addEventListener('click',()=>{if(el<HTMLFormElement>('backtest-form').reportValidity())void run(()=>window.trader.backtest(request(true)));});
el('bt-cancel').addEventListener('click',()=>void run(()=>window.trader.cancelBacktest()));el('bt-json').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('json')));el('bt-csv').addEventListener('click',()=>void run(()=>window.trader.exportBacktest('csv')));
el('bt-source').addEventListener('change',()=>{const real=value('bt-source')!=='sample';el<HTMLOptionElement>('bt-strategy').querySelector<HTMLOptionElement>('option[value=demo]')!.disabled=real;if(real)el<HTMLSelectElement>('bt-strategy').value='codex';});
el('codex-login').addEventListener('click',()=>void run(()=>window.trader.loginCodex()));
schedulingFields('bt');void refresh().catch(()=>message('文字介面連線失敗'));setInterval(()=>void refresh().catch(()=>undefined),1000);
