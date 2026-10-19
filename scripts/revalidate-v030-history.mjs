/** Private diagnostic only. No removed-trade return is presented as a counterfactual portfolio. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {SettingsSchema} from '../dist/src/core/models.js';
import {CodexAnalysisSchema} from '../dist/src/core/codex.js';
import {diagnoseCodexFailure} from '../dist/src/core/codex-failure.js';
import {confirmationIssues} from '../dist/src/core/entry-policy.js';
import {deterministicAdvice} from '../dist/src/core/execution.js';
import {compactSnapshot,tableContext} from '../dist/src/core/prompt-input.js';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw Error('node scripts/revalidate-v030-history.mjs PRIVATE_HISTORY.json PRIVATE_OUTPUT.json');
if(!relative(process.cwd(),resolve(output)).startsWith('..'))throw Error('Keep private diagnostics outside the repository');
const document=JSON.parse(readFileSync(source)),events=document.events,requests=new Map(),rows=[],failures=[],contexts=[],usage={};let latestOutput;
for(const e of events){
  if(e.stage==='SNAPSHOT'&&e.details?.request_id)requests.set(e.details.request_id,e.details);
  if(e.stage==='SNAPSHOT'&&e.details?.universe){const s=e.details;
    contexts.push({at:e.asof,review:s.review_only,original_bytes:Buffer.byteLength(JSON.stringify(s)),columnar_bytes:Buffer.byteLength(JSON.stringify(tableContext(s))),compact_columnar_bytes:Buffer.byteLength(JSON.stringify(tableContext(compactSnapshot(s))))});}
  if(e.stage==='OUTPUT')latestOutput=e.message;
  if(e.stage==='FAILED'){
    try{const result=CodexAnalysisSchema.safeParse(JSON.parse(latestOutput));failures.push({at:e.asof,...(result.success?{revalidated:true}:{diagnostic:diagnoseCodexFailure(result.error),issues:result.error.issues.map(i=>({path:i.path,code:i.code,message:i.message}))})});}
    catch(error){failures.push({at:e.asof,diagnostic:diagnoseCodexFailure(error)});}
  }
  if(e.stage==='USAGE'){const r=usage[e.purpose]??={calls:0,input_tokens:0,output_tokens:0};r.calls++;r.input_tokens+=e.details.input_tokens;r.output_tokens+=e.details.output_tokens;}
  if(e.stage==='SIZE_DECISION'&&e.details){const a=e.details,r=requests.get(a.request_id);if(!r)throw Error('Missing sizing request');
    const settings=SettingsSchema.parse(Object.fromEntries(Object.entries(r.hard_limits).filter(([key])=>Object.hasOwn(SettingsSchema.shape,key))));
    const advice=deterministicAdvice(r,settings),quote=r.lots.find(l=>l.lot===a.lot)?.quote;
    rows.push({at:e.asof,symbol:a.symbol,action:a.action,reference_shares:r.condition?.shares??null,actual_shares:a.shares,actual_limit:a.limit_price,
      deterministic:advice,stop_at_limit_down:r.action==='BUY'&&Number(r.protection?.stop_price)<=Number(r.instrument.limit_down),
      policies:Object.fromEntries(['trend','pullback','breakout'].map(p=>[p,confirmationIssues(p,r.features,quote,r.condition)]))});
  }
}
const totals=contexts.reduce((r,c)=>{for(const key of ['original_bytes','columnar_bytes','compact_columnar_bytes'])r[key]=(r[key]??0)+c[key];return r;},{});
writeFileSync(output,JSON.stringify({scope:'Recorded-account-path diagnostic, NOT a new portfolio backtest',usage,failures,contexts,context_totals:totals,sizing:rows,
  limitations:['Byte savings are measured, new billed tokens/error rates/decision quality are NOT_RUN without paid paired model calls.','Removing 18 recorded sizing calls is a mechanical 87-to-69 comparison; changed strategies can change future calls.','Confirmation results use the original account path; do not sum only retained PnL to claim new returns.']},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({usage,context_totals:totals,sizing:rows.length,failures:failures.length}));
