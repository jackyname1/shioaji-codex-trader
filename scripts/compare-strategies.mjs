import {readFile,writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {runBacktest} from '../dist/src/core/backtest.js';
import {syntheticDataset} from '../dist/src/core/backtest-data.js';
import {SettingsSchema} from '../dist/src/core/models.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
const dataset=args.dataset?JSON.parse(args.dataset.endsWith('.b64')?inflateSync(Buffer.from((await readFile(args.dataset,'utf8')).trim(),'base64')).toString('utf8'):await readFile(args.dataset,'utf8')):
  syntheticDataset(args.start??'2026-08-03',args.end??'2026-10-15');
const start=args.start??'2026-09-15',end=args.end??'2026-10-15';
const common={start,end,strategy:'rules',source:dataset.synthetic?'sample':'csv',initial_cash:'100000',capital_profile:'active',
  cost_profile:'conservative',slippage_fraction:'0.001',entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15','11:45'],whole_lots:true,
  participation:'0.01',monitor_interval_seconds:300};
const results=[];
for(const optimization of ['baseline','entries','exits','allocation','integrated']){
  const r=await runBacktest({...common,optimization},dataset,SettingsSchema.parse({}),undefined,new AbortController().signal,p=>{if(p.phase==='RECONCILE'&&p.points&&p.points%1000===0)console.error(optimization+': '+p.points+'/'+p.total_points+' '+p.day);});
  results.push({optimization,status:r.status,metrics:r.metrics,diagnostics:r.entry_diagnostics,failures:r.failures,
    daily_equity:r.daily_equity,quality:r.quality,exit_triggers:r.metrics.exit_metrics?.exit_triggers});
  console.log(JSON.stringify({optimization,status:r.status,pnl:r.metrics.net_pnl,drawdown:r.metrics.max_drawdown_pct,
    exposure:r.metrics.average_exposure_pct,fills:r.metrics.fill_count,exits:r.metrics.exit_metrics}));
}
const report={version:'0.2.3',source:dataset.source,synthetic:dataset.synthetic,coverage:dataset.coverage??'FULL_INPUT',
  dataset_sha256:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),common,results,
  limitations:['Baseline uses the unchanged v0.2.2 deterministic rule policy on the common corrected execution engine, not the original stochastic Codex decisions.',
    'All five runs share data, fees, starting cash, slippage, participation and cost/gap risk checks.',
    ...(dataset.limitations??[])]};
if(args.output)await writeFile(args.output,JSON.stringify(report,null,2)+'\n');
