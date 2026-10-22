// Fixed, previously studied public daily panel. No fitting and no paid model/broker calls.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {runBacktest} from '../dist/src/core/backtest.js';
import {SettingsSchema} from '../dist/src/core/models.js';

const output=resolve(process.argv[2]??'private/backtest-accounting');mkdirSync(output,{recursive:true,mode:0o700});
const raw=readFileSync('validation/twse-daily.json.gz'),dataset=JSON.parse(gunzipSync(raw));
const cases=[['earlier_neutral','2025-04-01','2025-06-30','neutral',0],
  ['later_neutral','2026-08-20','2026-10-15','neutral',0],['later_conservative','2026-08-20','2026-10-15','conservative',30]];
const results=[];
for(const [label,start,end,fill_assumption,execution_slippage_bps] of cases){
  const request={start,end,source:'csv',strategy:'rules',capital_profile:'custom',initial_cash:'100000',strategy_every_sessions:5,
    entry_cadence:'market',monitor_interval_seconds:300,watch_refresh_minutes:5,fill_assumption,execution_slippage_bps,execution_sizing:'deterministic'};
  const settings=SettingsSchema.parse({entry_policy:'legacy',execution_sizing:'deterministic',min_entry_reward_risk:'1.2',
    max_trade_risk_fraction:'0.01',watch_max_symbols:16,watch_min_amount:'20000000'});
  const report=await runBacktest(request,dataset,settings,undefined,new AbortController().signal);
  writeFileSync(join(output,label+'.json.gz'),gzipSync(JSON.stringify(report)),{mode:0o600});
  const a=report.diagnostics.audit,row={label,request,status:report.status,net_pnl:report.metrics.net_pnl,realized_pnl:report.metrics.realized_pnl,
    estimated_remaining_exit_costs:a.estimated_remaining_exit_costs,net_pnl_after_estimated_exit_costs:a.net_pnl_after_estimated_exit_costs,
    closed_trades:report.metrics.trades.closed_trades,audit_passed:a.passed,evaluation:report.diagnostics.evaluation.status,
    strategy_coverage:report.diagnostics.coverage,stale_marks:a.stale_valuation_symbols};
  results.push(row);console.log(JSON.stringify(row));
  writeFileSync(join(output,'summary.json'),JSON.stringify({dataset_sha256:createHash('sha256').update(raw).digest('hex'),
    scope:'Previously studied public daily panel, program rules, no Codex calls. Not a fresh holdout or the user minute strategy.',
    limitations:dataset.limitations,results},null,2),{mode:0o600});
  if(!a.passed)throw new Error('Accounting audit failed; do not use these results');
}
