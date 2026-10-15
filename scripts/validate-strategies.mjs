import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {runBacktest} from '../dist/src/core/backtest.js';
import {syntheticDataset,validateDataset} from '../dist/src/core/backtest-data.js';
import {SettingsSchema,twDay} from '../dist/src/core/models.js';
import {replayCapitalSettings} from '../dist/src/core/capital.js';
import {roundPrice} from '../dist/src/core/risk.js';

const modes=['baseline','entries','exits','allocation','integrated'];
const common={strategy:'rules',initial_cash:'100000',capital_profile:'custom',cost_profile:'conservative',
  slippage_fraction:'0.001',entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15','11:45'],
  whole_lots:true,participation:'0.01',monitor_interval_seconds:300};
const base=replayCapitalSettings(SettingsSchema.parse({}),'active');
const digest=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
const header=(data,start,end)=>({version:'0.2.3',source_commit:process.env.VALIDATION_SOURCE_COMMIT??null,
  source:data.source,synthetic:data.synthetic,coverage:data.coverage??'FULL_INPUT',dataset_sha256:digest(data),
  common:{...common,start,end,source:data.synthetic?'sample':'csv'},base_settings:base,
  limitations:['Baseline is the unchanged v0.2.2 deterministic rule policy on the same corrected execution engine; it is not a rerun of the original stochastic Codex decisions.',
    'All five variants share source data, cash, fees, slippage, execution participation, hard capital limits and conservative cost/gap checks.',
    'Synthetic fixtures validate mechanics and sensitivity only. They cannot establish historical alpha or select profitable real-world defaults.',
    'Sparse journal observations cannot reconstruct a full minute path or supply an authentic historical out-of-sample test.',
    ...(data.limitations??[])]});
async function run(data,start,end,optimization,settings=base){
  const r=await runBacktest({...common,start,end,source:data.synthetic?'sample':'csv',optimization},data,settings,
    undefined,AbortSignal.timeout(480000));
  if(r.status==='FAILED'||r.status!=='COMPLETED'&&data.coverage!=='SPARSE_OBSERVATIONS')
    throw new Error(JSON.stringify({optimization,status:r.status,failures:r.failures}));
  const result={optimization,status:r.status,metrics:r.metrics,diagnostics:r.entry_diagnostics,
    quality:r.quality,failures:r.failures,daily_equity:r.daily_equity,exit_triggers:r.metrics.exit_metrics?.exit_triggers};
  console.log(JSON.stringify({case:data.source,optimization,status:r.status,pnl:r.metrics.net_pnl,
    drawdown:r.metrics.max_drawdown_pct,exposure:r.metrics.average_exposure_pct,fills:r.metrics.fill_count,
    setups:r.entry_diagnostics?.program_setups,orders:r.entry_diagnostics?.strategy_orders,
    waits:r.entry_diagnostics?.waits?.slice(0,6),idle:r.entry_diagnostics?.idle_reasons?.filter(x=>x.samples)}));
  return result;
}
await mkdir('validation-output',{recursive:true});
const observed=validateDataset(JSON.parse(inflateSync(Buffer.from((await readFile('tests/fixtures/observed-market-v022.deflate.b64','utf8')).trim(),'base64')).toString('utf8')));
const observedReport={...header(observed,'2026-09-15','2026-10-15'),results:[]};
for(const mode of modes){observedReport.results.push(await run(observed,'2026-09-15','2026-10-15',mode));
  await writeFile('validation-output/observed-comparison.json',JSON.stringify(observedReport,null,2)+'\n');}

const start='2026-08-03',end='2026-10-15',sample=syntheticDataset(start,end);
const sampleReport={...header(sample,start,end),observation_step_minutes:10,results:[]};
for(const mode of modes){sampleReport.results.push(await run(sample,start,end,mode));
  await writeFile('validation-output/synthetic-comparison.json',JSON.stringify(sampleReport,null,2)+'\n');}

const configs=[
  {name:'current',changes:{}},
  {name:'order_15pct',changes:{max_order_fraction:'0.15'}},
  {name:'order_25pct',changes:{max_order_fraction:'0.25'}},
  {name:'cash_25pct',changes:{min_cash_fraction:'0.25',max_exposure_fraction:'0.75'}},
  {name:'risk_1pct',changes:{max_trade_risk_fraction:'0.01'}},
  {name:'breakeven_1R',changes:{breakeven_r_multiple:'1'}},
  {name:'trail_2ATR',changes:{trailing_atr_multiple:'2'}}
];
const grid={...header(sample,start,end),observation_step_minutes:10,
  split:{development:['2026-08-03','2026-09-11'],held_out:['2026-09-14','2026-10-15']},
  selection:'Predeclared sensitivity cases. No strategy or capital default is selected from synthetic returns.',results:[]};
for(const config of configs){
  const settings=SettingsSchema.parse({...base,...config.changes}),row={...config};
  for(const [split,[from,to]] of Object.entries(grid.split))row[split]=await run(sample,from,to,'integrated',settings);
  grid.results.push(row);
  await writeFile('validation-output/parameter-sensitivity.json',JSON.stringify(grid,null,2)+'\n');
}
await writeFile('validation-output/parameter-sensitivity.json',JSON.stringify(grid,null,2)+'\n');

function stressData(kind){
  const raw=structuredClone(sample);
  raw.points=raw.points.filter(p=>['9001','9002','9003'].includes(p.symbol));
  const days=[...new Set(raw.points.map(p=>twDay(new Date(p.at))))].filter(day=>day>='2026-09-14');
  const dayIndex=new Map(days.map((day,i)=>[day,i]));
  for(const point of raw.points){
    const day=twDay(new Date(point.at)),at=new Date(point.at),minute=at.getUTCHours()*60+at.getUTCMinutes()+480;
    let factor=1;
    if(kind==='TREND'&&day>='2026-09-14')factor=1.002**dayIndex.get(day);
    if(kind==='GAP'&&day>='2026-09-23')factor=.905;
    if(factor!==1)for(const k of ['open','high','low','close'])point[k]=roundPrice(Number(point[k])*factor);
    if(kind==='GAP'&&day==='2026-09-23'&&minute<600){
      point.bid='0';point.bid_shares=0;point.ask=roundPrice(Number(point.close)*1.002,false);point.ask_shares=20000;
    }
    if(kind==='ILLIQUID'){point.bid_shares=2;point.ask_shares=2;}
  }
  raw.source='SYNTHETIC '+kind+' stress; 10-minute observed events; no real market performance';
  raw.limitations=[...(raw.limitations??[]),'Gap path permanently reprices quotes; no-bid interval has zero sell depth. Illiquidity caps each event at two shares.'];
  return validateDataset(raw);
}
const stress={version:'0.2.3',source_commit:process.env.VALIDATION_SOURCE_COMMIT??null,
  common,period:['2026-09-14','2026-10-15'],synthetic:true,observation_step_minutes:10,
  limitations:['Designed execution/strategy stress only, not an estimate of real-world returns.'],cases:[]};
for(const kind of ['CHOP','TREND','GAP','ILLIQUID']){
  const data=stressData(kind),entry={kind,dataset_sha256:digest(data),results:[]};
  for(const mode of modes)entry.results.push(await run(data,'2026-09-14','2026-10-15',mode));
  stress.cases.push(entry);
  await writeFile('validation-output/stress-comparison.json',JSON.stringify(stress,null,2)+'\n');
}
await writeFile('validation-output/stress-comparison.json',JSON.stringify(stress,null,2)+'\n');
console.log('STRATEGY_VALIDATION_COMPLETED');
