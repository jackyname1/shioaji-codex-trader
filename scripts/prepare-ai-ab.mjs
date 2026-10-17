/** OFFLINE ONLY: prepare identical-snapshot low/medium/high trials and audit cached outputs.
 * No provider calls, credentials, pricing assumptions or fabricated returns.
 */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {analysisPrompt,CodexAnalysisSchema} from '../dist/src/core/codex.js';
import {compactSnapshot} from '../dist/src/core/prompt-input.js';
const [source,out,responses]=process.argv.slice(2);if(!source||!out)throw Error('node scripts/prepare-ai-ab.mjs HISTORY.json PRIVATE_OUTPUT [CACHED_RESPONSE_DIR]');
mkdirSync(out,{recursive:true});const es=JSON.parse(readFileSync(source)).events;
const snapshots=new Map();for(const e of es)if(e.stage==='SNAPSHOT'&&e.details?.universe)snapshots.set(e.details.snapshot_id,e.details);
const runs=[],comparisons=[];let originalBytes=0,compactBytes=0;
for(const [id,snapshot] of snapshots){
 const original=analysisPrompt(snapshot),compacted=analysisPrompt(compactSnapshot(snapshot));
 originalBytes+=Buffer.byteLength(original);compactBytes+=Buffer.byteLength(compacted);
 // Data shared byte-for-byte by all three reasoning trials; no future outcomes enter prompts.
 const file=id+'.input.json',hash=createHash('sha256').update(original).digest('hex');
 writeFileSync(resolve(out,file),JSON.stringify({asof:snapshot.asof,prompt:original,prompt_sha256:hash},null,2));
 for(const reasoning of ['low','medium','high']){
  const response=responses?resolve(responses,`${id}.${reasoning}.json`):null;
  const run={snapshot_id:id,asof:snapshot.asof,model:'gpt-6.1-sol',reasoning,input:file,prompt_sha256:hash,status:'NOT_RUN'};
  if(response&&existsSync(response)){
   const stored=JSON.parse(readFileSync(response));
   if(stored.prompt_sha256!==hash||stored.reasoning!==reasoning||stored.model!==run.model)throw Error('Cached output provenance differs from controlled trial');
   const parsed=CodexAnalysisSchema.safeParse(stored.analysis);
   run.status=parsed.success&&parsed.data.snapshot_id===id?'VALID_FORMAT':'INVALID_FORMAT';
   run.usage=stored.usage??null;run.latency_ms=stored.latency_ms??null;run.actual_cost=stored.actual_cost??null;
  }
  runs.push(run);
 }
}
const manifest={offline:true,snapshots:snapshots.size,runs,original_prompt_bytes:originalBytes,compacted_prompt_bytes:compactBytes,
 reduction_pct:originalBytes?(1-compactBytes/originalBytes)*100:0,
 limitations:['Prospective controlled prompts; original custom instructions may not be in the export.',
  'Byte reduction is not billed-token/cost reduction; no unrecorded provider price is assumed.',
  'Format validity is not strategy profitability. Real OOS policy replay needs complete market data and actual outputs for every trial.',
  'No medium/high response was synthesized. All missing responses remain NOT_RUN.']};
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({snapshots:manifest.snapshots,runs:runs.length,completed:runs.filter(r=>r.status!=='NOT_RUN').length,byte_reduction_pct:manifest.reduction_pct}));
