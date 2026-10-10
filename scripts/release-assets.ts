import { mkdir,copyFile,writeFile } from 'node:fs/promises';
import { syntheticDataset } from '../dist/src/core/backtest-data.js';
import { runBacktest } from '../dist/src/core/backtest.js';
import { SettingsSchema } from '../dist/src/core/models.js';
await mkdir('release',{recursive:true});
await copyFile('README.md','release/README.md');
await copyFile('docs/RELEASE_NOTES.md','release/RELEASE_NOTES.md');
const start='2026-10-01',end='2026-10-08',dataset=syntheticDataset(start,end);
const report=await runBacktest({start,end,source:'sample',strategy:'demo',initial_cash:'100000',strategy_schedule:'fixed',
  strategy_times:['09:15','11:45'],monitor_interval_seconds:3,watch_refresh_minutes:5},dataset,SettingsSchema.parse({}),undefined,new AbortController().signal);
if(report.status!=='COMPLETED'||!report.metrics.filled_orders)throw new Error('Release demonstration did not pass');
await writeFile('release/SYNTHETIC-demo-backtest.json',JSON.stringify(report,null,2));
const fields=['symbol','at','open','high','low','close','volume_shares'] as const;
await writeFile('release/SYNTHETIC-historical-sample.csv',fields.join(',')+'\n'+dataset.points.map(p=>fields.map(k=>p[k]).join(',')).join('\n')+'\n');
console.log('Release notes and clearly labelled synthetic test assets prepared.');
