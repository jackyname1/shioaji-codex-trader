import {d,type Order} from './models.js';
import type {SimulatedFill} from '../broker/paper.js';

/** Completed flat-to-flat symbol episodes, grouping partial fills and scale-outs. Open episodes are excluded. */
export function tradeStatistics(fills:SimulatedFill[],orders:Order[]=[]){
  const positions=new Map<string,{shares:number;pnl:string;entry_at:string;exits:string[]}>(),closed:string[]=[],episodes:{symbol:string;entry_at:string;exit_at:string;holding_hours:number;pnl:string;exit_reason:string}[]=[];
  for(const f of fills){
    const p=positions.get(f.symbol)??{shares:0,pnl:'0',entry_at:f.at,exits:[]};
    if(f.action==='BUY')p.shares+=f.shares;
    else {p.exits.push(orders.find(o=>o.local_id===f.order_id)?.exit_trigger??'EXPLICIT');p.shares-=f.shares;p.pnl=d(p.pnl).plus(f.realized_pnl??0).toFixed();
      if(p.shares<0)throw new Error('績效計算出現負庫存');
      if(p.shares===0){closed.push(p.pnl);episodes.push({symbol:f.symbol,entry_at:p.entry_at,exit_at:f.at,holding_hours:(Date.parse(f.at)-Date.parse(p.entry_at))/3600000,pnl:p.pnl,exit_reason:new Set(p.exits).size===1?p.exits[0]!:'MIXED'});positions.delete(f.symbol);continue;}}
    positions.set(f.symbol,p);
  }
  const wins=closed.map(d).filter(x=>x.gt(0)),losses=closed.map(d).filter(x=>x.lt(0));
  const gains=wins.reduce((a,b)=>a.plus(b),d(0)),loss=losses.reduce((a,b)=>a.minus(b),d(0));
  return {closed_trades:closed.length,winning_trades:wins.length,losing_trades:losses.length,
    win_rate_pct:closed.length?d(wins.length).div(closed.length).times(100).toFixed(4):null,
    average_win:wins.length?gains.div(wins.length).toFixed(4):null,average_loss:losses.length?loss.div(losses.length).toFixed(4):null,
    average_win_loss_ratio:wins.length&&losses.length?gains.div(wins.length).div(loss.div(losses.length)).toFixed(4):null,
    profit_factor:loss.gt(0)?gains.div(loss).toFixed(4):null,profit_factor_unbounded:gains.gt(0)&&loss.eq(0),
    expectancy:closed.length?closed.reduce((sum,p)=>sum.plus(p),d(0)).div(closed.length).toFixed(4):null,
    average_holding_hours:episodes.length?episodes.reduce((sum,p)=>sum+p.holding_hours,0)/episodes.length:null,episodes,
    by_exit_reason:Object.fromEntries([...new Set(episodes.map(e=>e.exit_reason))].map(reason=>{const rows=episodes.filter(e=>e.exit_reason===reason);return [reason,{trades:rows.length,pnl:rows.reduce((sum,e)=>sum.plus(e.pnl),d(0)).toFixed()}];})),
    closed_trade_pnls:closed};
}
export function exitStatistics(orders:Order[]){
  const counts:Record<string,{submitted:number;filled:number;rejected:number}>={};
  for(const o of orders.filter(o=>o.action==='SELL')){
    const key=o.exit_trigger??(o.purpose==='PROTECTION'?'LEGACY_PROTECTION':'EXPLICIT');
    const c=counts[key]??={submitted:0,filled:0,rejected:0};c.submitted++;if(o.filled)c.filled++;if(o.status==='REJECTED')c.rejected++;
  }
  return counts;
}
export function waitCategory(reason:string):string {
  if(/日損失/.test(reason))return 'DAILY_LOSS';
  if(/交割.*(未入帳|不可|待收)|待收款/.test(reason))return 'UNSETTLED_CREDIT';
  if(/報酬風險|風險報酬/.test(reason))return 'REWARD_RISK';
  if(/費|成本效益|淨利不足/.test(reason))return 'COST';
  if(/資金|購買力|現金|預算/.test(reason))return 'BUYING_POWER';
  if(/單筆|單檔|單一|持倉|上限|去重/.test(reason))return 'POSITION_OR_RISK_LIMIT';
  if(/行情|資料|資格|暖機/.test(reason))return 'DATA';
  if(/拒絕|REJECTED/.test(reason))return 'ORDER_REJECTED';
  if(/無有效候選|沒有合格/.test(reason))return 'NO_CANDIDATE';
  if(/等待|追蹤|觸發|條件|過熱|超時/.test(reason))return 'TRIGGER';
  return 'OTHER';
}
