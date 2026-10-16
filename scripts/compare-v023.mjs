import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runBacktest} from '../dist/src/core/backtest.js';
import {SettingsSchema} from '../dist/src/core/models.js';
import {programAnalysis} from '../dist/src/core/program-strategy.js';

const [datasetPath,baselinePath,outputPath='validation/comparison.json']=process.argv.slice(2);
if(!datasetPath||!baselinePath)throw new Error('Usage: node scripts/compare-v023.mjs DATASET.json BASELINE_WORKTREE_DIR [OUTPUT.json]');
const bytes=readFileSync(datasetPath),dataset=JSON.parse(bytes);
const {programAnalysis:original}=await import(pathToFileURL(resolve(baselinePath,'dist/src/core/program-strategy.js')).href);
const variants=[['v022',false,false,false],['entries',true,false,false],['exits',false,true,false],['allocation',false,false,true],['combined',true,true,true]];
const common={mode:'paper',auto_execute:false,min_cash_fraction:'0.20',max_order_fraction:'0.20',order_budget_basis:'EQUITY',
  target_exposure_fraction:'0.70',max_symbol_fraction:'0.25',max_exposure_fraction:'0.80',max_daily_buy_fraction:'0.60',max_daily_buy_orders:8,
  max_trade_risk_fraction:'0.0125',daily_loss_fraction:'0.02',min_entry_reward_risk:'1.2',watch_max_symbols:16,
  fee_rate:'0.001425',minimum_fee:'20',sell_tax_rate:'0.003',risk_slippage_fraction:'0.001',max_gap_risk_fraction:'0.02',overnight_gap_fraction:'0.05',
  min_net_profit_twd:'60'};
const periods=[['development','2025-05-01','2026-03-31'],['out_of_sample','2026-04-01','2026-10-15']];
const results=[];
mkdirSync(resolve(outputPath,'..'),{recursive:true});
const metadata={dataset_sha256:createHash('sha256').update(bytes).digest('hex'),source:dataset.source,frequency:dataset.frequency,
  baseline_source:'v0.2.2 original programAnalysis loaded from separately checked out baseline; common corrected execution/accounting/risk engine',
  baseline_commit:'df744f638b1013b9d644218818862e8e19180872',common,
  limitations:['Not a rerun of the original model-selected September/October trades: the exported execution log lacks their complete minute dataset.',
    'All five cases share the same corrected fills, fee/tax rounding, T+2 availability at 11:00, daily-loss latch and cost/stress gates.',
    'Daily OHLC uses only prior completed bars and modeled open/close fills, not intraday path reconstruction.',
    'The OOS split was fixed before results; this is one fixed liquid-stock pool with survivorship and unadjusted corporate-action limitations.']};
const save=()=>writeFileSync(outputPath,JSON.stringify({...metadata,results},null,2)+'\n');
for(const [period,start,end] of periods){
  for(const [variant,entries,exits,allocation] of variants){
    const settings=SettingsSchema.parse({...common,entry_strategy_mode:entries?'multi':'legacy',adaptive_protection:exits,dynamic_allocation:allocation});
    const policy=(snapshot,s)=>{
      const a=entries?programAnalysis(snapshot,s):original(snapshot,s);
      if(!entries&&allocation&&a.screening?.entry)a.screening.entry.allocation_fraction=s.max_order_fraction;
      return a;
    };
    const request={start,end,source:'csv',strategy:'rules',capital_profile:'custom',entry_cadence:'market',strategy_schedule:'interval',
      decision_interval_minutes:180,monitor_interval_seconds:300,watch_refresh_minutes:5,initial_cash:'100000',participation:'0.01'};
    const report=await runBacktest(request,dataset,settings,undefined,new AbortController().signal,undefined,undefined,undefined,undefined,undefined,policy);
    results.push({period,variant,status:report.status,metrics:report.metrics,diagnostics:report.entry_diagnostics,quality:report.quality,
      limitations:report.limitations});save();
    console.log(JSON.stringify({period,variant,status:report.status,return_pct:report.metrics.return_pct,drawdown:report.metrics.max_drawdown_pct,
      exposure:report.metrics.average_close_exposure_pct,trades:report.metrics.trades?.closed_trades}),true);
  }
}
// Prespecified development-only budget sensitivity. No OOS selection from the winning return.
for(const [label,overrides] of [['order15',{max_order_fraction:'0.15'}],['order18',{max_order_fraction:'0.18'}],
  ['cash25',{min_cash_fraction:'0.25',max_exposure_fraction:'0.75'}],['target60',{target_exposure_fraction:'0.60'}],
  ['risk1pct',{max_trade_risk_fraction:'0.01'}]]){
  const settings=SettingsSchema.parse({...common,...overrides,entry_strategy_mode:'multi',adaptive_protection:true,dynamic_allocation:true});
  const report=await runBacktest({start:'2025-05-01',end:'2026-03-31',source:'csv',strategy:'rules',entry_cadence:'market',strategy_schedule:'interval',
    decision_interval_minutes:180,monitor_interval_seconds:300,watch_refresh_minutes:5,initial_cash:'100000'},dataset,settings,undefined,new AbortController().signal);
  results.push({period:'sensitivity_development_only',variant:label,status:report.status,overrides,metrics:report.metrics,diagnostics:report.entry_diagnostics});save();
  console.log(JSON.stringify({sensitivity:label,return_pct:report.metrics.return_pct}),true);
}
