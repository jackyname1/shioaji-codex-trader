import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runBacktest} from '../dist/src/core/backtest.js';
import {syntheticDataset,validateDataset} from '../dist/src/core/backtest-data.js';
import {SettingsSchema} from '../dist/src/core/models.js';
import {replayCapitalSettings} from '../dist/src/core/capital.js';

const kind=process.argv[2]??'observed',optimization=process.argv[3]??'baseline';
assert.ok(['observed','synthetic'].includes(kind));
assert.ok(['baseline','entries','exits','allocation','integrated'].includes(optimization));
const start=kind==='observed'?'2026-09-15':'2026-08-03',end='2026-10-15';
const dataset=kind==='observed'?validateDataset(JSON.parse(inflateSync(Buffer.from((await readFile('tests/fixtures/observed-market-v022.deflate.b64','utf8')).trim(),'base64')).toString())):syntheticDataset(start,end);
const common={strategy:'rules',initial_cash:'100000',capital_profile:'custom',cost_profile:'conservative',
  slippage_fraction:'0.001',entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15','11:45'],
  whole_lots:true,participation:'0.01',monitor_interval_seconds:300};
const seen=new Set(),reasons=new Map();
const result=await runBacktest({...common,start,end,source:dataset.synthetic?'sample':'csv',optimization},dataset,
  replayCapitalSettings(SettingsSchema.parse({}),'active'),undefined,AbortSignal.timeout(480000),()=>{},undefined,frame=>{
    for(const decision of frame.decisions??[]){
      const key=JSON.stringify([frame.at,decision.symbol,decision.state,decision.reason]);
      if(seen.has(key))continue;seen.add(key);
      const name=decision.state+': '+decision.reason;reasons.set(name,(reasons.get(name)??0)+1);
    }
  });
const output=process.env.VALIDATION_OUTPUT_DIR??'validation-final';await mkdir(output,{recursive:true});
const existing=JSON.parse(await readFile(output+'/'+kind+'-comparison.json','utf8'));
assert.deepEqual(result.metrics,existing.results.find(r=>r.optimization===optimization)?.metrics,'Audit changed the comparison metrics');
const report={version:'0.2.3',engine_source_commit:process.env.VALIDATION_SOURCE_COMMIT??null,
  audit_script_sha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  dataset_sha256:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),kind,optimization,status:result.status,
  metrics_match_comparison:true,fill_risk_breaches:result.fill_risk_checks.filter(c=>c.issues.length),
  risk_events:result.workflow.filter(e=>e.stage==='RISK'),
  reason_observation_scope:'Distinct replay frame time + symbol + state + reason; not time-weighted and not equivalent to monitor samples.',
  decision_reason_observations:[...reasons].map(([reason,observations])=>({reason,observations})).sort((a,b)=>b.observations-a.observations)};
await writeFile(output+'/'+kind+'-'+optimization+'-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,decision_reason_observations:report.decision_reason_observations.slice(0,12)},null,2));
