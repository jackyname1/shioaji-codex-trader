import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditBacktest} from '../src/core/backtest-audit.js';
import {runBacktest,type BacktestReport} from '../src/core/backtest.js';
import {backtestDiagnostics,backtestExport} from '../src/core/backtest-export.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {SettingsSchema,d} from '../src/core/models.js';
import {order} from './helpers.js';

let generated:Promise<BacktestReport>|undefined;
async function report(){
  if(!generated){const data=syntheticDataset('2026-01-05','2026-01-09');data.points=data.points.filter(p=>p.symbol==='9001');
    generated=runBacktest({start:'2026-01-05',end:'2026-01-09',source:'sample',strategy:'demo'},data,SettingsSchema.parse({}),undefined,new AbortController().signal);}
  return structuredClone(await generated);
}
function manual(r:BacktestReport):BacktestReport{
  const b='2026-01-05T02:00:00.000Z',s='2026-01-06T02:00:00.000Z';
  r.fills=[
    {id:'b1',order_id:'buy',at:b,symbol:'9001',action:'BUY',lot:'ODD',purpose:'ENTRY',shares:10,price:'100',amount:'1000',fee:'20',tax:'0',realized_pnl:null},
    {id:'b2',order_id:'buy',at:'2026-01-05T02:01:00.000Z',symbol:'9001',action:'BUY',lot:'ODD',purpose:'ENTRY',shares:10,price:'101',amount:'1010',fee:'0',tax:'0',realized_pnl:null},
    {id:'s1',order_id:'sell',at:s,symbol:'9001',action:'SELL',lot:'ODD',purpose:'EXIT',shares:12,price:'110',amount:'1320',fee:'20',tax:'4',realized_pnl:'74'},
  ];
  r.orders=[order({local_id:'buy',shares:20,limit_price:'101',status:'FILLED',filled:20,created_at:'2026-01-05T01:59:00Z'}),
    order({local_id:'sell',action:'SELL',purpose:'EXIT',shares:12,limit_price:'110',status:'FILLED',filled:12,created_at:'2026-01-06T01:59:00Z'})];
  r.asof='2026-01-06T05:30:00.000Z';r.positions=[{symbol:'9001',shares:8,sellable:8,average_price:'101',cost_basis:'808',last_price:'111'}];
  r.quality.last_marks={'9001':r.asof};
  Object.assign(r.metrics,{initial_cash:'100000',final_cash:'97970',settlement_credits:'1296',stock_value:'888',final_equity:'100154',
    net_pnl:'154',realized_pnl:'74',unrealized_pnl:'80',fees:'40',taxes:'4',gross_pnl:'198',total_costs:'44',fill_count:3,filled_orders:2,sell_orders:1});
  return r;
}

test('the independent audit reconciles a full engine replay and all exported diagnostics',async()=>{
  const r=await report(),a=auditBacktest(r);assert.ok(a.passed,JSON.stringify(a.checks));
  assert.ok(d(a.recomputed_equity).eq(r.metrics.final_equity));assert.deepEqual(a,JSON.parse(backtestExport(r,'json').content).diagnostics.audit);
  assert.match(backtestExport(r,'audit').content,/獨立帳務稽核/);assert.equal(backtestDiagnostics(r).evaluation.status,'FLOW_TEST');
});

test('manual partial-fill FIFO allocates the buy fee once and keeps T+2 credits in equity',async()=>{
  const r=manual(await report()),a=auditBacktest(r);assert.ok(a.passed,JSON.stringify(a.checks));
  assert.equal(a.recomputed_realized_pnl,'74.00');assert.equal(a.remaining_cost_basis,'808.00');
  assert.equal(a.estimated_remaining_exit_costs,'23.00');assert.equal(a.net_pnl_after_estimated_exit_costs,'131.00');
  assert.deepEqual(a.stale_valuation_symbols,[]);
  for(const [key,value,code] of [['realized_pnl','75','EQUITY_PNL'],['settlement_credits','1300','CASH_SETTLEMENTS'],['fees','41','FEES_TAXES']] as const){
    const changed=structuredClone(r);changed.metrics[key]=value;assert.equal(auditBacktest(changed).checks.find(c=>c.code===code)!.passed,false);
  }
});

test('duplicate, pre-submission, over-limit and oversold fills cannot pass the audit',async()=>{
  const r=manual(await report());
  for(const change of [
    (x:BacktestReport)=>{x.fills[1]!.id=x.fills[0]!.id;},
    (x:BacktestReport)=>{x.fills[0]!.at=x.orders[0]!.created_at;},
    (x:BacktestReport)=>{x.orders[0]!.limit_price='99';},
    (x:BacktestReport)=>{x.fills[2]!.shares=21;},
  ]){const changed=structuredClone(r);change(changed);assert.equal(auditBacktest(changed).passed,false);assert.equal(backtestDiagnostics(changed).evaluation.status,'ACCOUNTING_ERROR');}
});

test('stale marks and estimated exit fees cannot be used as a passed profitability result',async()=>{
  const r=manual(await report());r.synthetic=false;
  assert.equal(backtestDiagnostics(r).evaluation.status,'INSUFFICIENT_SAMPLE');
  r.quality.last_marks['9001']='2026-01-06T02:00:00Z';
  assert.equal(backtestDiagnostics(r).evaluation.status,'INCOMPLETE');assert.ok(backtestDiagnostics(r).findings.some(f=>f.code==='STALE_VALUATION'));
  r.quality.last_marks['9001']=r.asof;
  // A small marked gain becomes a loss after the remaining sale's minimum fee and tax.
  r.positions[0]!.last_price='92.5';Object.assign(r.metrics,{stock_value:'740',final_equity:'100006',net_pnl:'6',unrealized_pnl:'-68',gross_pnl:'50'});
  assert.equal(auditBacktest(r).passed,true);assert.equal(backtestDiagnostics(r).evaluation.status,'NOT_PROFITABLE');
  assert.equal(auditBacktest(r).net_pnl_after_estimated_exit_costs,'-17.00');
});
