import {Decimal} from 'decimal.js';
import {d,twDay} from './models.js';
import {COMMON_MAX_SHARES} from './stock-lot.js';
import type {BacktestReport} from './backtest.js';

/** Independent reconstruction from exported fills; does not trust the report's P/L totals. */
export function auditBacktest(r:BacktestReport){
  const checks:{code:string;passed:boolean;message:string}[]=[];
  const check=(code:string,passed:boolean,message:string)=>checks.push({code,passed,message});
  const equal=(a:Decimal.Value,b:Decimal.Value)=>d(a).isFinite()&&d(b).isFinite()&&d(a).minus(b).abs().lte('.02');
  const inventory=new Map<string,{shares:number;cost:Decimal;day:string}[]>(),ids=new Set<string>();
  const filled=new Map<string,{shares:number;amount:Decimal;fee:Decimal;tax:Decimal}>();
  let cash=d(r.request.initial_cash),realized=d(0),fees=d(0),taxes=d(0),previous=-Infinity;
  let chronology=true,unique=true,identity=true,amounts=true,fifo=true,charges=true;
  const orders=new Map(r.orders.map(o=>[o.local_id,o]));
  for(const f of r.fills){
    const at=Date.parse(f.at),o=orders.get(f.order_id);
    chronology&&=Number.isFinite(at)&&at>=previous&&at<=Date.parse(r.asof)&&!!o&&at>Date.parse(o.created_at);
    previous=at;unique&&=!ids.has(f.id);ids.add(f.id);
    identity&&=!!o&&o.symbol===f.symbol&&o.action===f.action&&o.lot===f.lot&&o.purpose===f.purpose
      &&(f.action==='BUY'?d(f.price).lte(o.limit_price):d(f.price).gte(o.limit_price));
    amounts&&=Number.isSafeInteger(f.shares)&&f.shares>0&&d(f.price).gt(0)&&equal(d(f.price).times(f.shares),f.amount);
    charges&&=d(f.fee).gte(0)&&d(f.tax).gte(0)&&(f.action==='SELL'||d(f.tax).eq(0));
    fees=fees.plus(f.fee);taxes=taxes.plus(f.tax);
    const total=filled.get(f.order_id)??{shares:0,amount:d(0),fee:d(0),tax:d(0)};
    total.shares+=f.shares;total.amount=total.amount.plus(f.amount);total.fee=total.fee.plus(f.fee);total.tax=total.tax.plus(f.tax);filled.set(f.order_id,total);
    const lots=inventory.get(f.symbol)??[];
    if(f.action==='BUY'){
      cash=cash.minus(f.amount).minus(f.fee);lots.push({shares:f.shares,cost:d(f.amount).plus(f.fee),day:twDay(new Date(f.at))});
      fifo&&=f.realized_pnl===null;
    }else{
      let needed=f.shares,basis=d(0);
      for(const lot of lots){
        const used=Math.min(needed,lot.shares);if(!used)continue;
        fifo&&=lot.day<twDay(new Date(f.at));
        const cost=lot.cost.times(used).div(lot.shares);basis=basis.plus(cost);lot.cost=lot.cost.minus(cost);lot.shares-=used;needed-=used;
      }
      fifo&&=needed===0;
      const proceeds=d(f.amount).minus(f.fee).minus(f.tax),pnl=proceeds.minus(basis);
      fifo&&=f.realized_pnl!==null&&equal(pnl,f.realized_pnl??0);cash=cash.plus(proceeds);realized=realized.plus(pnl);
    }
    inventory.set(f.symbol,lots.filter(l=>l.shares>0));
  }
  let balances=true,costBasis=d(0),stock=d(0),exitCosts:Decimal|null=d(0);
  const symbols=new Set([...inventory.keys(),...r.positions.map(p=>p.symbol)]),positionSymbols=new Set<string>();
  for(const p of r.positions){balances&&=!positionSymbols.has(p.symbol);positionSymbols.add(p.symbol);}
  const minimum=r.settings.minimum_fee,rate=r.settings.fee_rate,taxRate=r.settings.sell_tax_rate;
  const costSettings=[minimum,rate,taxRate].every(v=>typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v));
  const fee=(amount:Decimal)=>Decimal.max(String(minimum),amount.times(String(rate)).ceil());
  if(!costSettings)exitCosts=null;
  for(const symbol of symbols){
    const lots=inventory.get(symbol)??[],shares=lots.reduce((sum,l)=>sum+l.shares,0),p=r.positions.find(p=>p.symbol===symbol);
    const basis=lots.reduce((sum,l)=>sum.plus(l.cost),d(0));costBasis=costBasis.plus(basis);
    balances&&=shares===(p?.shares??0)&&(!p?.cost_basis||equal(p.cost_basis,basis));
    if(!p||p.shares<=0)continue;
    stock=stock.plus(d(p.last_price).times(p.shares));
    if(exitCosts!==null){
      // Estimate fees per legal order: common lots and any remaining odd-lot shares.
      let left=p.shares;
      const add=(n:number,count=1)=>{const amount=d(p.last_price).times(n);
        exitCosts=exitCosts!.plus(fee(amount).plus(amount.times(String(taxRate)).ceil()).times(count));};
      if(r.request.whole_lots){const full=Math.floor(left/COMMON_MAX_SHARES);if(full){add(COMMON_MAX_SHARES,full);left-=full*COMMON_MAX_SHARES;}
        const common=Math.floor(left/1000)*1000;if(common){add(common);left-=common;}}
      const fullOdd=Math.floor(left/999);if(fullOdd){add(999,fullOdd);left-=fullOdd*999;}if(left)add(left);
    }
  }
  for(const o of r.orders){const total=filled.get(o.local_id);identity&&=(total?.shares??0)===o.filled&&o.filled<=o.shares;
    if(total&&costSettings)charges&&=equal(total.fee,fee(total.amount))&&equal(total.tax,o.action==='SELL'?total.amount.times(String(taxRate)).ceil():0);}
  const m=r.metrics,unrealized=stock.minus(costBasis),expected=cash.plus(stock);
  check('FILL_CHRONOLOGY',chronology,'成交須晚於送單，依時間排序且不超過回測截止。');
  check('UNIQUE_FILLS',unique,'成交識別不可重複。');
  check('ORDER_RECONCILIATION',identity&&orders.size===r.orders.length,'成交方向、股票、限價、股數及委託累計須一致。');
  check('FILL_AMOUNTS',amounts,'成交金額須等於價格乘股數。');
  check('FIFO_COSTS',fifo&&balances,'FIFO 買進成本含手續費，賣出不得超賣或當沖，期末庫存須一致。');
  check('FEES_TAXES',costSettings&&charges&&equal(fees,m.fees)&&equal(taxes,m.taxes),'部分成交費用按委託累計；費稅須與成交及設定一致。');
  check('SUMMARY_COUNTS',m.fill_count===r.fills.length&&m.filled_orders===filled.size
    &&(m.sell_orders===undefined||m.sell_orders===new Set(r.fills.filter(f=>f.action==='SELL').map(f=>f.order_id)).size)
    &&equal(m.initial_cash,r.request.initial_cash)&&(m.total_costs===undefined||equal(m.total_costs,fees.plus(taxes))),
    '起始資金、成交筆數、成交委託數與總成本須與原始紀錄一致。');
  check('CASH_SETTLEMENTS',equal(cash,d(m.final_cash).plus(m.settlement_credits)),'成交現金流須等於期末現金加待收交割款。');
  check('EQUITY_PNL',equal(stock,m.stock_value)&&equal(expected,m.final_equity)&&equal(expected.minus(r.request.initial_cash),m.net_pnl)
    &&equal(realized,m.realized_pnl)&&equal(unrealized,m.unrealized_pnl)&&equal(realized.plus(unrealized),m.net_pnl)
    &&(m.gross_pnl===undefined||equal(d(m.gross_pnl).minus(fees).minus(taxes),m.net_pnl)),
    '期末淨值、已實現與未實現損益須與獨立成交重算一致（容許分幣四捨五入）。');
  const day=twDay(new Date(r.asof)),markCutoff=Math.min(Date.parse(r.asof),Date.parse(day+'T13:30:00+08:00'));
  const staleMarks=r.positions.filter(p=>p.shares>0).filter(p=>{const at=Date.parse(r.quality.last_marks[p.symbol]??'');
    return !Number.isFinite(at)||at>markCutoff||markCutoff-at>300000;}).map(p=>p.symbol);
  return {passed:checks.every(c=>c.passed),checks,recomputed_equity:expected.toFixed(2),recomputed_realized_pnl:realized.toFixed(2),
    remaining_cost_basis:costBasis.toFixed(2),stale_valuation_symbols:staleMarks,
    estimated_remaining_exit_costs:exitCosts?.toFixed(2)??null,
    net_pnl_after_estimated_exit_costs:exitCosts===null?null:expected.minus(r.request.initial_cash).minus(exitCosts).toFixed(2)};
}
