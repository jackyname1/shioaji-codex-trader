import type {TrayBridge} from './tray-preload.cjs';
import type {TraySnapshot} from './dashboard.js';
declare global {interface Window {overview:TrayBridge}}
const el=(id:string)=>document.getElementById(id)!;
const text=(id:string,v:string)=>{el(id).textContent=v;};
let latest:TraySnapshot|undefined,busy=false,privateMoney=false;
const options=[...document.querySelectorAll<HTMLInputElement>('[data-section]')];
try{const saved=JSON.parse(localStorage.getItem('overview-display')??'{}') as Record<string,boolean>;
  for(const option of options)option.checked=saved[option.dataset.section!]!==false;privateMoney=saved.privacy===true;
}catch{/* Malformed preferences use visible defaults. */}
(el('privacy') as HTMLInputElement).checked=privateMoney;
function preferences(){for(const option of options)document.querySelector<HTMLElement>(`[data-panel="${option.dataset.section}"]`)!.hidden=!option.checked;}
preferences();
for(const option of [...options,el('privacy') as HTMLInputElement])option.addEventListener('change',()=>{
  privateMoney=(el('privacy') as HTMLInputElement).checked;
  try{localStorage.setItem('overview-display',JSON.stringify({...Object.fromEntries(options.map(o=>[o.dataset.section,o.checked])),privacy:privateMoney}));}catch{/* Display still updates without storage. */}
  preferences();if(latest)render(latest);
});
el('customize').addEventListener('click',()=>{el('preferences').hidden=!el('preferences').hidden;el('customize').setAttribute('aria-expanded',String(!el('preferences').hidden));});
for(const [id,target] of [['open','workspace'],['settings','settings'],['diagnostics','diagnostics'],['strategy-open','strategy']] as const)el(id).addEventListener('click',()=>void window.overview.open(target).catch(failed));
el('hide').addEventListener('click',()=>void window.overview.hide());document.addEventListener('keydown',e=>{if(e.key==='Escape')void window.overview.hide();});
function failed(error:unknown){text('issue',error instanceof Error?error.message:'速覽資料暫時無法更新');el('issue').hidden=false;}
function rows(id:string,items:{symbol:string;title:string;detail:string;right:string}[],empty:string){
  const host=el(id),signature=JSON.stringify(items)+privateMoney;if(host.dataset.signature===signature)return;host.dataset.signature=signature;
  const nodes=items.map(item=>{const button=document.createElement('button');button.className='mini-row';button.dataset.symbol=item.symbol;
    const left=document.createElement('span'),name=document.createElement('b'),detail=document.createElement('small'),right=document.createElement('span');
    name.textContent=item.title;detail.textContent=item.detail;right.textContent=item.right;left.append(name,detail);button.append(left,right);
    button.addEventListener('click',()=>void window.overview.open('strategy',item.symbol).catch(failed));return button;});
  if(!nodes.length){const p=document.createElement('p');p.className='empty';p.textContent=empty;host.replaceChildren(p);}else host.replaceChildren(...nodes);
}
function render(s:TraySnapshot){const money=(v:string)=>privateMoney?'••••':v;
  for(const [id,v] of Object.entries({clock:s.clock,workspace:s.workspace,activity:s.activity,updated:s.updated,connection:s.connection,codex:s.codex,issue:s.issue,cash:money(s.cash),equity:money(s.equity),settlement:privateMoney?'交割金額已隱藏':s.settlement,'account-at':'帳務截至 '+s.accountAt,next:s.next,monitor:s.monitor,'order-count':String(s.orders),summary:s.strategy,expiry:s.expiry}))text(id,v);
  el('issue').hidden=!s.issue;
  rows('positions',s.positions.map(p=>({symbol:p.symbol,title:p.symbol+' '+p.name,detail:privateMoney?'股數已隱藏':p.shares,right:money(p.pnl)})),'目前無持倉，或持倉資料尚未就緒');
  rows('watch',s.watch.map(w=>({symbol:w.symbol,title:w.symbol+' '+w.name,detail:w.state,right:w.price})),'尚無監測股票');
  rows('strategies',s.strategies.map(d=>({symbol:d.symbol,title:d.symbol+' '+d.name+' · '+d.action,detail:d.trigger+' · '+d.price,right:d.state})),'本輪沒有個股決策；請查看上方策略與主視窗規則');
  rows('pending',s.pending.map(o=>({symbol:o.symbol,title:o.symbol+' '+o.action,detail:(privateMoney?'股數已隱藏':o.quantity)+' · 限價 '+o.price,right:o.status})),'目前無未完成委託');
}
async function refresh(){if(busy)return;busy=true;try{latest=await window.overview.state();render(latest);}catch(e){failed(e);}finally{busy=false;}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});window.addEventListener('focus',()=>void refresh());
setInterval(()=>{if(!document.hidden)void refresh();},1000);void refresh();
