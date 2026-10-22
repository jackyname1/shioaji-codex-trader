// Usage: node scripts/replay-export.mjs REPORT.json DATASET.json[.gz] OUTPUT_DIRECTORY
// The second-turn journal is required when the original request used Codex sizing.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {FrozenDecisions} from '../dist/src/core/frozen-decisions.js';
import {runBacktest} from '../dist/src/core/backtest.js';
import {SettingsSchema} from '../dist/src/core/models.js';
import {backtestExport} from '../dist/src/core/backtest-export.js';
const [reportPath,datasetPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw new Error('Usage: node scripts/replay-export.mjs REPORT.json DATASET.json[.gz] OUTPUT_DIRECTORY');
const reportRaw=readFileSync(reportPath),raw=JSON.parse(reportRaw),marketRaw=readFileSync(datasetPath),dataset=JSON.parse(datasetPath.endsWith('.gz')?gunzipSync(marketRaw):marketRaw);
const frozen=new FrozenDecisions(raw.analyst_events??[]),settings=SettingsSchema.parse({...(raw.effective_settings??raw.settings),mode:'paper',codex_enabled:true,auto_execute:false}),output=resolve(outputPath);
mkdirSync(output,{recursive:true,mode:0o700});
// Save untouched input before replay. Do not regenerate it from parsed/normalized output.
writeFileSync(join(output,'baseline-original.json'),reportRaw,{mode:0o600});
const report=await runBacktest({...raw.request,comparison_intervals:[]},dataset,settings,frozen.analyze,new AbortController().signal,undefined,undefined,undefined,undefined,frozen.size);
report.limitations.push('固定原始 AI 回覆之條件重播；重建帳戶、行情及風控。僅重綁已核對原始 ID，未修改期限、數量、價位或歷史成交；分歧未涵蓋的模型呼叫會失敗，無法稱為完整反事實 AI 策略。');
report.analyst_events=raw.analyst_events;
const sha=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(join(output,'replay-manifest.json'),JSON.stringify({baseline_file_sha256:sha(reportRaw),dataset_file_sha256:sha(marketRaw),original_build:raw.build,replay_build:report.build,settings_inference:raw.effective_settings?'complete exported settings':'legacy partial settings; omitted fields use current schema defaults and cannot establish an exact original replay',coverage:frozen.coverage()},null,2),{mode:0o600});
for(const format of ['json','csv','orders','trades','daily','failures','funnel','rejections','strategies','decisions','attribution','audit']){
 const e=backtestExport(report,format);writeFileSync(join(output,'replayed-'+format+'.'+e.extension),e.content,{mode:0o600});
}
console.log(JSON.stringify({status:report.status,metrics:report.metrics,coverage:frozen.coverage(),audit:report.diagnostics.audit},null,2));
