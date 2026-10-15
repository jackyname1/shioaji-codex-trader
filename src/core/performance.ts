import {d} from './models.js';
import type {SimulatedFill} from '../broker/paper.js';
/** One exit order is one observation; partial fills must not inflate win rate. Not a round-trip cycle count. */
export function exitMetrics(fills:SimulatedFill[]){
  const exits=new Map<string,ReturnType<typeof d>>(),triggers=new Map<string,Set<string>>();
  for(const f of fills)if(f.action==='SELL'&&f.realized_pnl!==null){
    exits.set(f.order_id,(exits.get(f.order_id)??d(0)).plus(f.realized_pnl));
    const key=f.exit_trigger??(f.purpose==='PROTECTION'?'LEGACY_PROTECTION':'STRATEGY_EXIT'),ids=triggers.get(key)??new Set<string>();
    ids.add(f.order_id);triggers.set(key,ids);
  }
  const values=[...exits.values()],wins=values.filter(x=>x.gt(0)),losses=values.filter(x=>x.lt(0));
  const gain=wins.reduce((s,x)=>s.plus(x),d(0)),loss=losses.reduce((s,x)=>s.minus(x),d(0));
  return {exit_orders:values.length,winning_exit_orders:wins.length,losing_exit_orders:losses.length,
    win_rate_pct:values.length?d(wins.length).div(values.length).times(100).toFixed(4):null,
    average_win:wins.length?gain.div(wins.length).toFixed(4):null,average_loss:losses.length?loss.div(losses.length).neg().toFixed(4):null,
    profit_factor:loss.gt(0)?gain.div(loss).toFixed(4):null,
    net_expectancy:values.length?gain.minus(loss).div(values.length).toFixed(4):null,
    exit_triggers:Object.fromEntries([...triggers].map(([key,ids])=>[key,ids.size]))};
}
export const IDLE_CATEGORIES=['NO_SIGNAL','TRIGGER_WAIT','REWARD_RISK','COST','BUYING_POWER','SETTLEMENT','ORDER_SYMBOL_LIMIT',
  'DATA','ORDER_REJECTED','DAILY_LOSS','OTHER'] as const;
export type IdleCategory=typeof IDLE_CATEGORIES[number];
export function idleCategory(reason:string):IdleCategory{
  if(/日損失/.test(reason))return 'DAILY_LOSS';
  if(/拒單|REJECTED/.test(reason))return 'ORDER_REJECTED';
  if(/報酬風險|風險比|收益目標/.test(reason))return 'REWARD_RISK';
  if(/停損風險|跳空|單筆|單一標的|總持倉|每日|單日|配置餘額/.test(reason))return 'ORDER_SYMBOL_LIMIT';
  if(/資金不足|購買力|現金保留|預算不足/.test(reason))return 'BUYING_POWER';
  if(/淨利|成本|費|碎單/.test(reason))return 'COST';
  if(/交割/.test(reason))return 'SETTLEMENT';
  if(/資金不足|購買力|現金保留|預算不足/.test(reason))return 'BUYING_POWER';
  if(/單筆|單一標的|持倉上限|每日|單日|配置餘額|風險預算/.test(reason))return 'ORDER_SYMBOL_LIMIT';
  if(/行情|資料|暖機|資格|交易時段/.test(reason))return 'DATA';
  if(/等待|追蹤|門檻|條件未成立|逾時|失效/.test(reason))return 'TRIGGER_WAIT';
  if(/HOLD|觀望|沒有合格|無有效/.test(reason))return 'NO_SIGNAL';
  return 'OTHER';
}
