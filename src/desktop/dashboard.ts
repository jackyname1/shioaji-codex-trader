import {reservedBuyCash} from '../core/buy-reservation.js';
import {planActive,planDeadline} from '../core/plan-lifecycle.js';
import type {Settings} from '../core/models.js';
import type {DesktopState,RuntimeView} from './shared.js';
import {workspaceRuntime,workspaceCutoff,replayView} from './workspace.js';

export interface StrategyItem {symbol:string;name:string;action:string;state:string;trigger:string;price:string;size:string;protection:string;reason:string}
const actions:Record<string,string>={BUY:'買進',SELL:'賣出',HOLD:'觀望',PENDING:'委託中',PARTIAL:'部分成交',CANCEL_PENDING:'撤單核對中',UNKNOWN:'結果待核對',QUEUED:'等待確認股數',RUNNING:'確認股數中',WAIT:'等待條件',BLOCKED:'風控阻擋',SUBMITTED:'已送單',FILLED:'已成交',SIZING:'確認股數',SIZE_FAILED:'股數確認未完成',TRACKING:'追蹤低點'};
export const dashboardTime=(at:string|null|undefined):string=>at&&Number.isFinite(Date.parse(at))?new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
export const dashboardNumber=(n:string|number):string=>Number(n).toLocaleString('zh-TW',{maximumFractionDigits:2});
export function strategyDirection(r:RuntimeView|null,s:Pick<Settings,'trade_direction'>,cutoff:string):{label:string;detail:string;restricted:boolean}{
  const plan=r?.plan,valid=planActive(plan,cutoff);
  if(s.trade_direction==='reduce_only')return {label:'僅減碼 · 禁止新買進',restricted:true,
    detail:'設定持續生效；依有效賣出條件與可賣庫存減碼，不指定固定減碼比例。自動交易啟動後核對並撤銷本程式的進場掛單；待撤單確認前仍可能成交。既有保護持續。'};
  if(!valid)return {label:plan?'策略已到期／尚未生效':'等待第一輪策略',restricted:true,
    detail:'等待新的有效策略；持倉停損與移動保護持續監測。'};
  if(plan!.analysis.stance==='BUY_ALLOWED')return {label:'允許條件買進',restricted:false,detail:'買進須同時符合策略條件、有效行情、可用資金與風控；持倉出場保護持續。'};
  if(plan!.analysis.stance==='HOLD_ONLY')return {label:'保留現金／觀望',restricted:true,detail:'本輪禁止新買進；明確賣出條件與持倉保護仍可執行。'};
  const sells=plan!.analysis.decisions.filter(d=>d.action==='SELL');
  return {label:'減碼優先 · 禁止新買進',restricted:true,detail:(sells.length
    ?`本輪 ${sells.length} 檔設定減碼賣單，股數、觸發條件與最低賣價見下表。`
    :'本輪沒有明確減碼賣單；等待出場條件或既有持倉保護觸發。')+'此方向本身不會立即賣出或清倉；僅處理可賣庫存，保護持續。'};
}
export function strategyItems(r:RuntimeView|null,cutoff:string,tradeDirection:Settings['trade_direction']='auto'):StrategyItem[]{
  if(!r)return [];
  const valid=planActive(r.plan,cutoff);
  return (r.plan?.analysis.decisions??[]).map(d=>{
    const guard=(d.conditions??[]).map(c=>`${c.left} ${{GT:'>',GTE:'≥',LT:'<',LTE:'≤'}[c.operator]} ${c.right==='VALUE'?c.value:c.right}`).join(' 且 ');
    const trigger=d.action==='HOLD'?'本輪不建立新委託':(d.entry_when==='IMMEDIATE'?'通過條件與風控後':d.entry_when==='REBOUND'?`跌至 ${d.trigger_price} 後，自低點回升 ${Number(d.rebound_fraction)*100}%`:`價格${d.entry_when==='BELOW'?'低於':'高於'} ${d.trigger_price}`)+(guard?'；且 '+guard:'');
    const spec=r.protections.find(p=>p.symbol===d.symbol)?.spec??d.smart;
    const decision=r.decisions.find(v=>v.symbol===d.symbol);
    const queue=r.execution_queue?.find(v=>v.symbol===d.symbol);
    const state=d.action==='BUY'&&(tradeDirection==='reduce_only'||r.plan?.analysis.stance!=='BUY_ALLOWED')?'方向禁止新買進':queue?actions[queue.state]??queue.state:!valid?'策略已到期／尚未生效':d.action==='HOLD'?'觀望':!r.connected?'等待連線':r.killed?'已停止新委託':r.paused&&d.action==='BUY'?'暫停新增買進':!r.auto?'等待啟動':r.blocked&&d.action==='BUY'?'新買進受阻':decision?actions[decision.state]??decision.state:'等待條件';
    return {symbol:d.symbol,name:r.metadata[d.symbol]?.name??r.watch.entries.find(w=>w.symbol===d.symbol)?.name??'',action:actions[d.action]!,state,trigger,
      price:d.action==='HOLD'?'—':`${d.action==='BUY'?'買價上限':'賣價下限'} ${d.limit_price}`,
      size:d.action==='HOLD'?'無新委託':`參考 ${dashboardNumber(d.shares)} 股 · 觸發後另核股數`,
      protection:spec?`停損 ${spec.stop_price} · ${spec.take_profit?'固定停利 '+spec.take_profit:'無固定停利'}${spec.trailing_activate?' · 移動啟動 '+spec.trailing_activate+'／回落 '+Number(spec.trailing_fraction)*100+'%':''}`:'本輪未設定新保護',
      reason:decision?.reason?d.reason+'；執行狀態：'+decision.reason:d.reason};
  });
}
export interface TraySnapshot {
  workspace:string;activity:string;connection:string;codex:string;issue:string;updated:string;accountAt:string;
  cash:string;equity:string;settlement:string;orders:number;next:string;monitor:string;strategy:string;expiry:string;
  positions:{symbol:string;name:string;shares:string;pnl:string}[];watch:{symbol:string;name:string;price:string;state:string}[];
  strategies:StrategyItem[];pending:{symbol:string;action:string;quantity:string;price:string;status:string}[];
}
// Explicit projection: no credentials, account identifiers, settings JSON or logs enter the tray renderer.
export function traySnapshot(state:DesktopState):TraySnapshot {
  const r=workspaceRuntime(state),a=r?.account,replay=replayView(state),cutoff=workspaceCutoff(state);
  const available=a?.available??{cash:true,settlements:true,positions:true,orders:true};
  const settings=JSON.parse(state.settings) as {fee_rate:string;minimum_fee:string;account_max_age:number;quote_max_age:number;trade_direction:Settings['trade_direction']};
  const fresh=!!a&&Number.isFinite(Date.parse(cutoff))&&Date.parse(cutoff)>=Date.parse(a.asof)&&Date.parse(cutoff)-Date.parse(a.asof)<=settings.account_max_age*1000;
  const reserved=Number(reservedBuyCash(a?.orders??[],settings));
  const full=!!a&&available.cash&&available.settlements&&available.positions&&available.orders&&fresh;
  const orders=(a&&available.orders?a.orders:r?.orders??[]).filter(o=>!['FILLED','CANCELLED','REJECTED'].includes(o.status));
  return {workspace:state.workspace_mode==='live'?'正式交易 · 真實帳戶':replay?'歷史回放 · 模擬時間':'即時模擬 · 虛擬資金',
    activity:replay?state.backtest_running?state.replay_paused?'回放已暫停':'歷史回放中':'回放待命':!r?.connected?'等待連線':r.killed?'已停止新委託':r.paused?'暫停新增買進':!r.auto?'已連線 · 待命':r.sizing?'Codex 確認股數':r.analyzing?'Codex 更新條件':r.blocked?'新買進受阻':!r.session?'交易時段外 · 持續監控':'自動監測中',
    connection:state.connection.status,codex:state.codex_auth.message,issue:state.error||(!replay&&state.workspace_mode==='live'?state.live.issues.join('；'):'')||(!fresh&&a?'帳務已過期，等待重新核對':''),
    updated:dashboardTime(cutoff),accountAt:dashboardTime(a?.asof),cash:full?dashboardNumber(Math.max(0,Number(a.cash)-Number(a.settlement_debits)-reserved)):'—',
    equity:full?dashboardNumber(Number(a.cash)-Number(a.settlement_debits)+Number(a.settlement_credits)+a.positions.reduce((s,p)=>s+Number(p.last_price)*p.shares,0)):'—',
    settlement:a&&available.settlements?`待付 ${dashboardNumber(a.settlement_debits)} · 待收 ${dashboardNumber(a.settlement_credits)}`:'交割資料待核對',orders:orders.length,
    next:replay?'回放依模擬排程':dashboardTime(r?.next_strategy_at),monitor:dashboardTime(r?.last_monitor_at),
    strategy:r?.plan?.analysis.summary??'等待第一輪有效策略；由程式產生選股與買賣條件。',
    expiry:r?.plan?planDeadline(r.plan)?`舊版有效至 ${dashboardTime(r.plan.analysis.expires_at)}${planActive(r.plan,cutoff)?'':' · 已到期'}`:'持續有效 · 直到新策略成功接替':'尚無有效策略',
    positions:a&&available.positions?a.positions.map(p=>({symbol:p.symbol,name:r?.metadata[p.symbol]?.name??'',shares:`${dashboardNumber(p.shares)} 股／可賣 ${dashboardNumber(p.sellable)}`,pnl:dashboardNumber((Number(p.last_price)-Number(p.average_price))*p.shares)})):[],
    watch:(r?.watch.entries??[]).map(w=>{const quote=r?.quotes.find(q=>q.symbol===w.symbol&&q.odd);
      const quoteFresh=quote&&Date.parse(cutoff)>=Date.parse(quote.trade_at)&&Date.parse(cutoff)-Date.parse(quote.trade_at)<=settings.quote_max_age*1000;
      return {symbol:w.symbol,name:w.name,price:quoteFresh?quote.last:'—',state:(actions[r?.decisions.find(d=>d.symbol===w.symbol)?.state??'']??w.reason)+' · 報價 '+dashboardTime(quote?.trade_at)+(quote&&!quoteFresh?'（已過期）':'')};}),
    strategies:strategyItems(r,cutoff,replay?(state.backtest_progress.running?state.backtest_progress.effective_settings?.trade_direction:state.backtest_result?.settings.trade_direction) as Settings['trade_direction']??'auto':settings.trade_direction),pending:orders.map(o=>({symbol:o.symbol,action:actions[o.action]??o.action,quantity:`${o.filled}／${o.shares} 股`,price:o.limit_price,status:actions[o.status]??o.status}))};
}

export function panelBounds(anchor:{x:number;y:number;width:number;height:number},area:{x:number;y:number;width:number;height:number}){
  const width=Math.min(440,area.width),height=Math.min(690,area.height);
  return {width,height,x:Math.round(Math.max(area.x,Math.min(anchor.x+anchor.width-width,area.x+area.width-width))),
    y:Math.round(Math.max(area.y,Math.min(anchor.y>=area.y+area.height/2?anchor.y-height:anchor.y+anchor.height,area.y+area.height-height)))};
}
