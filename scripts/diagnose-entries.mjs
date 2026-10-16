import {writeFile} from 'node:fs/promises';
import {runBacktest} from '../dist/src/core/backtest.js';
import {syntheticDataset} from '../dist/src/core/backtest-data.js';
import {SettingsSchema} from '../dist/src/core/models.js';
import {replayCapitalSettings} from '../dist/src/core/capital.js';

// Designed data only: records the decision path without exporting account data.
const start=process.argv[2]??'2026-08-03',end=process.argv[3]??'2026-08-14';
const data=syntheticDataset(start,end),seen=new Map(),states={},reasons={},examples=[];
const report=await runBacktest({start,end,source:'sample',strategy:'rules',optimization:'entries',
  initial_cash:'100000',capital_profile:'custom',cost_profile:'conservative',slippage_fraction:'0.001',
  whole_lots:true,entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15','11:45'],
  participation:'0.01',monitor_interval_seconds:300},data,replayCapitalSettings(SettingsSchema.parse({}),'active'),
  undefined,AbortSignal.timeout(480000),()=>{},undefined,frame=>{
    for(const track of frame.entry_tracks??[]){
      const key=[track.plan_id,track.symbol,track.lot,track.strategy].join(':'),signature=JSON.stringify(track);
      if(seen.get(key)===signature)continue;seen.set(key,signature);
      const state=track.strategy+':'+track.state;states[state]=(states[state]??0)+1;
      const decision=(frame.adaptive_decisions??[]).find(d=>d.symbol===track.symbol&&d.entry_strategy===track.strategy);
      const feedback=frame.decisions?.find(d=>d.symbol===track.symbol);
      if(feedback){const reason=feedback.state+':'+feedback.reason;reasons[reason]=(reasons[reason]??0)+1;}
      if(examples.length<120&&(track.state==='READY'||track.state==='CONFIRMING'))examples.push({at:frame.at,track,decision,feedback});
    }
  });
const result={synthetic:true,period:[start,end],metrics:report.metrics,diagnostics:report.entry_diagnostics,states,reasons,examples};
await writeFile('validation-output/entry-diagnosis.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({metrics:report.metrics,states,reasons,examples:examples.slice(0,8)},null,2));
