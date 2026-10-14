import { active, ageSeconds, d, equity, marketValue, remaining, twDay, type Account, type Candidate, type Decision, type Features,
  type Instrument, type Order, type Plan, type Protection, type Quote, type Settings } from './models.js';
import { Decimal } from 'decimal.js';
import { roundPrice, fee } from './risk.js';
import {orderBudget} from './capital.js';

export interface WatchEntry {
  symbol:string; name:string; state:'OBSERVE'|'RETAINED'; source:'CODEX'|'SCANNER';
  eligible:boolean; score:number; reason:string; added_at:string; checked_at:string; misses:number;
}
export interface WatchChange {at:string;symbol:string;action:'ADD'|'REMOVE'|'RETAIN';reason:string}
export interface WatchState {asof:string;plan_id:string;healthy:boolean;issue:string;scans:number;adds:number;removes:number;entries:WatchEntry[];changes:WatchChange[]}
export const emptyWatch=():WatchState=>({asof:'',plan_id:'',healthy:false,issue:'等待首次觀測更新',scans:0,adds:0,removes:0,entries:[],changes:[]});
export interface WatchBundle {pool:Candidate[];features:Record<string,Features>;metadata:Record<string,Instrument>}
export function watchEligibility(c:Candidate,f:Features|undefined,m:Instrument|undefined,settings:Settings,plan:Plan|undefined,now:Date):string[] {
  const reasons:string[]=[];
  if(!m||m.kind!=='STOCK'||! /^[1-9]\d{3}$/.test(c.symbol)||m.suspended||m.disposition||(m.attention&&!settings.allow_attention)
    ||twDay(new Date(m.verified_at))!==twDay(now))reasons.push('商品資格或今日資料未確認');
  if(!f?.sufficient)reasons.push('歷史暖機不足或資料過期');
  const policy=plan?.analysis.screening;
  const floor=Decimal.max(policy?.min_amount??'0',settings.watch_min_amount);
  if(d(f?.daily_amount??c.amount).lt(floor))reasons.push('已知成交金額不足');
  if(policy) {
    if(f?.volume_ratio20===undefined||d(f.volume_ratio20).lt(policy.min_volume_ratio))reasons.push('量能未達條件');
    if(f?.rsi14===undefined||f.rsi14<policy.rsi_min||f.rsi14>policy.rsi_max)reasons.push('RSI 未達條件');
    if(f?.return20===undefined||d(f.return20).lt(policy.return20_min))reasons.push('20 日趨勢未達條件');
  }
  return reasons;
}
export function selectWatchlist(previous:WatchState,bundle:WatchBundle,settings:Settings,plan:Plan|undefined,
  account:Account|undefined,orders:Order[],protections:Protection[],now:Date):WatchState {
  const at=now.toISOString(),changes:WatchChange[]=[],selected=new Set(plan?.analysis.candidates??[]);
  const explicitBuys=new Set(plan?.analysis.decisions.filter(d=>d.action==='BUY').map(d=>d.symbol)??[]);
  const pins=new Map<string,string>();
  account?.positions.filter(p=>p.shares>0).forEach(p=>pins.set(p.symbol,'持倉：保護監控持續'));
  orders.filter(active).forEach(o=>pins.set(o.symbol,'未完成委託：保留核對'));
  protections.filter(p=>pins.has(p.symbol)).forEach(p=>pins.set(p.symbol,pins.get(p.symbol)!+'、智慧單保護'));
  const pool=new Map(bundle.pool.map(c=>[c.symbol,c])),before=new Map(previous.entries.map(w=>[w.symbol,w]));
  const eligible=bundle.pool.flatMap(c=>{
    const reasons=watchEligibility(c,bundle.features[c.symbol],bundle.metadata[c.symbol],settings,plan,now);
    if(reasons.length)return [];
    const f=bundle.features[c.symbol],score=Math.round((Math.log10(Math.max(1,Number(f?.daily_amount??c.amount)))*10
      +(f?.return20??0)*30+Math.min(f?.volume_ratio20??0,3)*3+(selected.has(c.symbol)?8:0)+(explicitBuys.has(c.symbol)?500:0))*100)/100;
    return [{c,score}];
  }).sort((a,b)=>b.score-a.score||a.c.symbol.localeCompare(b.c.symbol));
  const good=new Map(eligible.map(x=>[x.c.symbol,x])),entries:WatchEntry[]=[];
  // Keep still-qualified observations before admitting newcomers, avoiding rank oscillation.
  for(const old of previous.entries) {
    const match=good.get(old.symbol);
    if(match)entries.push({...old,state:'OBSERVE',eligible:true,score:match.score,checked_at:at,misses:0,
      source:selected.has(old.symbol)?'CODEX':'SCANNER',reason:'符合目前選股條件'});
    else {
      const misses=old.misses+1,reason=pool.has(old.symbol)?watchEligibility(pool.get(old.symbol)!,bundle.features[old.symbol],bundle.metadata[old.symbol],settings,plan,now).join('；'):'已離開動態資料池';
      if(pins.has(old.symbol)) {
        entries.push({...old,state:'RETAINED',eligible:false,checked_at:at,misses,reason:pins.get(old.symbol)!});
        if(old.state!=='RETAINED')changes.push({at,symbol:old.symbol,action:'RETAIN',reason:pins.get(old.symbol)!});
      }else if(misses<settings.watch_remove_after_scans)entries.push({...old,eligible:false,checked_at:at,misses,reason:`${reason}（${misses}/${settings.watch_remove_after_scans} 次）`});
      else changes.push({at,symbol:old.symbol,action:'REMOVE',reason});
    }
  }
  // Reducing the configured cap removes the lowest-scored unpinned observations first.
  let observations=entries.filter(x=>x.state==='OBSERVE');
  for(const w of [...observations].sort((a,b)=>a.score-b.score)) {
    if(observations.length<=settings.watch_max_symbols)break;
    if(pins.has(w.symbol)){w.state='RETAINED';w.eligible=false;w.reason=pins.get(w.symbol)!;}
    else {entries.splice(entries.indexOf(w),1);changes.push({at,symbol:w.symbol,action:'REMOVE',reason:'觀測數量上限調整'});}
    observations=entries.filter(x=>x.state==='OBSERVE');
  }
  if(previous.plan_id!==plan?.id){
    const incoming=eligible.filter(x=>selected.has(x.c.symbol)&&!entries.some(w=>w.symbol===x.c.symbol&&w.state==='OBSERVE')).length;
    while(entries.filter(w=>w.state==='OBSERVE').length>settings.watch_max_symbols-Math.min(incoming,settings.watch_max_symbols)) {
    const victim=entries.filter(w=>w.state==='OBSERVE'&&!selected.has(w.symbol)).sort((a,b)=>a.score-b.score)[0];if(!victim)break;
    if(pins.has(victim.symbol)){victim.state='RETAINED';victim.eligible=false;victim.reason=pins.get(victim.symbol)!;
      changes.push({at,symbol:victim.symbol,action:'RETAIN',reason:'策略更新；'+victim.reason});}
    else {entries.splice(entries.indexOf(victim),1);changes.push({at,symbol:victim.symbol,action:'REMOVE',reason:'Codex 新策略更新觀測優先股'});}
    }
  }
  const admission=[...eligible.filter(x=>selected.has(x.c.symbol)),...eligible.filter(x=>!selected.has(x.c.symbol))];
  for(const {c,score} of admission) {
    if(entries.some(w=>w.symbol===c.symbol)||entries.filter(w=>w.state==='OBSERVE').length>=settings.watch_max_symbols)continue;
    const w:WatchEntry={symbol:c.symbol,name:c.name,state:'OBSERVE',source:selected.has(c.symbol)?'CODEX':'SCANNER',eligible:true,
      score,reason:selected.has(c.symbol)?'Codex 候選符合選股條件':'動態掃描符合選股條件',added_at:before.get(c.symbol)?.added_at??at,checked_at:at,misses:0};
    entries.push(w);changes.push({at,symbol:c.symbol,action:'ADD',reason:w.reason});
  }
  for(const [symbol,reason] of pins)if(!entries.some(w=>w.symbol===symbol)) {
    entries.push({symbol,name:pool.get(symbol)?.name??symbol,state:'RETAINED',source:'SCANNER',eligible:false,score:0,
      reason,added_at:at,checked_at:at,misses:0});changes.push({at,symbol,action:'RETAIN',reason});
  }
  const qualified=entries.filter(w=>w.state==='OBSERVE'&&w.eligible).length;
  return {asof:at,plan_id:plan?.id??'',healthy:true,issue:qualified===0?'本輪沒有合格觀測股；保留現金，持倉保護持續':qualified<5?`本輪 ${qualified} 檔符合條件，依 Codex 條件監測，不強制補股`:'',
    scans:previous.scans+1,adds:(previous.adds??0)+changes.filter(c=>c.action==='ADD').length,
    removes:(previous.removes??0)+changes.filter(c=>c.action==='REMOVE').length,
    entries:entries.sort((a,b)=>a.state.localeCompare(b.state)||b.score-a.score),changes:[...previous.changes,...changes].slice(-120)};
}
export function ruleEntry(plan:Plan,w:WatchEntry,f:Features|undefined,q:Quote|undefined,a:Account,s:Settings,now:Date):{decision?:Decision;reason:string} {
  const rule=plan.analysis.screening?.entry;
  if(!rule||plan.analysis.stance!=='BUY_ALLOWED')return {reason:'等待 Codex 個股決策'};
  if(!w.eligible||w.state!=='OBSERVE')return {reason:w.reason};
  if(!f?.sufficient||!f.ma20||!f.ma5||!f.resistance20)return {reason:'策略指標不足'};
  if(!q||q.simulated||ageSeconds(now,q.trade_at)<0||ageSeconds(now,q.trade_at)>s.quote_max_age
    ||ageSeconds(now,q.book_at)<0||ageSeconds(now,q.book_at)>s.quote_max_age||!d(q.ask).gt(0))return {reason:'等待新鮮成交與五檔行情'};
  const last=d(q.last),distance=last.minus(f.ma20).abs().div(f.ma20);
  if(distance.gt(rule.max_ma20_distance))return {reason:'價格距離 MA20 超過策略範圍'};
  if(rule.signal==='TREND'&&!(last.gte(f.ma20)&&d(f.ma5).gte(f.ma20)))return {reason:'等待多頭趨勢條件'};
  if(rule.signal==='BREAKOUT20'&&!last.gt(f.resistance20))return {reason:'等待突破此前 20 日壓力'};
  if(rule.signal==='PULLBACK20'&&!(d(f.ma5).gte(f.ma20)&&last.gte(f.ma20)&&last.lte(d(f.ma20).times('1.01'))))return {reason:'等待回測 MA20 條件'};
  const limit=roundPrice(q.ask,false),e=equity(a),buys=a.orders.filter(o=>active(o)&&o.action==='BUY');
  const reserved=buys.reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))).plus(fee(d(o.limit_price).times(remaining(o)),s)),d(0));
  const reservedAmount=buys.reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))),d(0));
  const cashRoom=d(a.cash).minus(a.settlement_debits).minus(reserved).minus(e.times(s.min_cash_fraction));
  const held=a.positions.find(p=>p.symbol===w.symbol),symbolHeld=held?d(held.last_price).times(held.shares):d(0);
  const symbolReserved=buys.filter(o=>o.symbol===w.symbol).reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))),d(0));
  const spend=Decimal.min(e.times(rule.allocation_fraction).minus(s.minimum_fee),
    orderBudget(e,s),cashRoom.minus(s.minimum_fee),
    e.times(s.max_symbol_fraction).minus(symbolHeld).minus(symbolReserved),e.times(s.max_exposure_fraction).minus(marketValue(a)).minus(reservedAmount),
    e.times(s.max_daily_buy_fraction).minus(a.daily_buy_amount));
  let shares=Math.min(999000,Math.max(0,Math.floor(spend.div(limit).toNumber())));
  if(!q.odd&&!s.whole_lots)return {reason:'整股尚未啟用'};
  shares=!q.odd?Math.floor(shares/1000)*1000:Math.min(999,shares);
  while(shares>0&&d(limit).times(shares).plus(fee(d(limit).times(shares).toFixed(),s)).gt(cashRoom))shares-=q.odd?1:1000;
  if(!shares)return {reason:'可用預算不足一股或最低手續費'};
  const stop=roundPrice(d(limit).times(d(1).minus(rule.stop_fraction))),take=roundPrice(d(limit).times(d(1).plus(rule.take_profit_fraction)));
  if(!d(stop).gt(0)||!d(stop).lt(limit)||!d(take).gt(limit))return {reason:'跳動單位使保護價不合法'};
  return {reason:'策略條件成立，送單前仍須通過硬性風控',decision:{symbol:w.symbol,action:'BUY',shares,limit_price:limit,
    entry_when:'IMMEDIATE',trigger_price:'0',smart:{stop_price:stop,take_profit:rule.trailing_fraction?null:take,reward_target:take,
      trailing_activate:rule.trailing_fraction?roundPrice(d(limit).times(d(1).plus(d(rule.take_profit_fraction).div(2)))):null,
      trailing_fraction:rule.trailing_fraction},reason:`Codex 規則 ${rule.signal}；${w.reason}；單輪每檔限一次進場`}};
}
