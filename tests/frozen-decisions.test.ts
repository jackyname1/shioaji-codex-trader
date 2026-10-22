import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrozenDecisions} from '../src/core/frozen-decisions.js';
import {demoAnalysis,validateAnalysis} from '../src/core/strategy.js';
import {now,settings,snapshot} from './helpers.js';
import type {AnalystEvent} from '../src/core/codex.js';
const events=(answer:unknown):AnalystEvent[]=>['SNAPSHOT','OUTPUT'].map(stage=>({at:now.toISOString(),asof:now.toISOString(),stage,message:stage==='OUTPUT'?JSON.stringify(answer):'fixture',model:'synthetic',reasoning:'none',run_id:'run',purpose:'STRATEGY',...(stage==='SNAPSHOT'?{details:snapshot()}:{} )}));
test('fixed raw replies rebind only their verified snapshot ID, retain expired deadlines and cannot be reused',async()=>{
 const input=snapshot(),bad={...demoAnalysis(input,settings(),now),expires_at:now.toISOString()},source=events(bad),before=JSON.stringify(source);
 const f=new FrozenDecisions(source),replay={...input,snapshot_id:'new-id'},reply=await f.analyze(replay);
 assert.equal(reply.snapshot_id,'new-id');assert.equal(reply.expires_at,bad.expires_at);assert.equal(JSON.stringify(source),before);
 assert.throws(()=>validateAnalysis(reply,replay,now,settings()),/REPLY_EXPIRED/);assert.equal(f.coverage().bindings.length,1);
 await assert.rejects(f.analyze(replay),/COVERAGE_GAP/);
});
test('an original mismatch, missing response or a later decision cannot become authority for an earlier call',async()=>{
 const input=snapshot();const bad=new FrozenDecisions(events({...demoAnalysis(input,settings(),now),snapshot_id:'wrong'}));
 await assert.rejects(bad.analyze(input),/SNAPSHOT_MISMATCH/);
 assert.throws(()=>new FrozenDecisions(events({}).filter(e=>e.stage!=='OUTPUT')),/MISSING_RAW_RESPONSE/);
 const f=new FrozenDecisions(events(demoAnalysis(input,settings(),now)));
 await assert.rejects(f.analyze({...input,asof:new Date(now.getTime()-60000).toISOString()}),/COVERAGE_GAP/);assert.equal(f.coverage().used,0);
});
