import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {SettingsSchema,twDay} from '../src/core/models.js';
import {backtestExport} from '../src/core/backtest-export.js';
test('later fresh marks do not certify an overnight position with unadjusted corporate-action entitlements',async()=>{
 const data=syntheticDataset('2026-09-08','2026-09-10');data.points=data.points.filter(p=>p.symbol==='9001');
 for(const p of data.points){const day=twDay(new Date(p.at)),price=day>='2026-09-09'?'27':'30';p.open=p.high=p.low=p.close=price;p.volume_shares=1000000;
  if(day==='2026-09-09'){p.corporate_action=true;p.reference_price='27';}}
 const r=await runBacktest({start:'2026-09-08',end:'2026-09-10',source:'sample',strategy:'codex',strategy_every_sessions:20,strategy_schedule:'fixed',strategy_times:['09:15'],execution_sizing:'deterministic'},data,
  SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>({snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+3600000).toISOString(),stance:'BUY_ALLOWED',candidates:['9001'],screening:null,summary:'Synthetic corporate-action regression',
   decisions:[{symbol:'9001',action:'BUY',shares:100,limit_price:'30.05',entry_when:'IMMEDIATE',trigger_price:'0',smart:{stop_price:'26',take_profit:'45',trailing_activate:null,trailing_fraction:null},conditions:[],reason:'Synthetic fixture'}]}),new AbortController().signal);
 assert.ok(r.fills.some(f=>f.action==='BUY'));assert.equal(r.diagnostics!.audit.passed,true);assert.deepEqual(r.diagnostics!.audit.stale_valuation_symbols,[]);
 assert.equal(r.status,'PARTIAL');assert.deepEqual(r.quality.corporate_action_exposure?.map(e=>[e.day,e.symbol,e.opening_shares]),[['2026-09-09','9001',100]]);
 assert.ok(r.diagnostics!.completeness.some(e=>e.code==='UNRESOLVED_CORPORATE_ACTION'));
 assert.match(backtestExport(r,'failures').content,/UNRESOLVED_CORPORATE_ACTION/);
});
