import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {spawn} from 'node:child_process';
import {codexModels,resolveCodexSelection,clearCodexModels} from '../src/core/codex-models.js';
import {SettingsSchema} from '../src/core/models.js';
import {prepareCodexProfile} from '../src/core/codex.js';

const model=(value:string,isDefault=false)=>({id:value,model:value,displayName:value,isDefault,defaultReasoningEffort:'high',
  supportedReasoningEfforts:[{reasoningEffort:'medium',description:'medium'},{reasoningEffort:'high',description:'high'}]});
function fixture(reply:(message:Record<string,unknown>)=>unknown){
  const messages:Record<string,unknown>[]=[],child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:Writable;kill:()=>boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=false;
  child.kill=()=>{killed=true;return true;};
  child.stdin=new Writable({write(chunk,_encoding,done){const message=JSON.parse(String(chunk)) as Record<string,unknown>;messages.push(message);
    queueMicrotask(()=>{const answer=reply(message);if(answer!==undefined)child.stdout.write(JSON.stringify(answer)+'\n');});done();}});
  let environment:NodeJS.ProcessEnv|undefined,args:string[]=[];
  const launch=((_binary:string,input:string[],options:{env:NodeJS.ProcessEnv})=>{args=input;environment=options.env;return child;}) as unknown as typeof spawn;
  return {launch,messages,child,get killed(){return killed;},get environment(){return environment;},get args(){return args;}};
}
function profile(){const root=mkdtempSync(join(tmpdir(),'model-catalog-'));prepareCodexProfile(root,join(root,'empty-source'));return root;}
test('native model discovery initializes first, follows pagination, and resolves the actual default and its effort',async()=>{
  const root=profile(),f=fixture(m=>m.method==='initialize'?{id:m.id,result:{userAgent:'fixture'}}:m.method==='model/list'?
    {id:m.id,result:m.params&&'cursor' in (m.params as object)?{data:[model('account-default',true)],nextCursor:null}:{data:[model('alternative')],nextCursor:'page2'}}:undefined);
  try{
    const catalog=await codexModels(SettingsSchema.parse({}),root,undefined,f.launch);assert.equal(catalog.length,2);assert.equal(f.killed,true);
    assert.deepEqual(f.messages.map(m=>m.method),['initialize','initialized','model/list','model/list']);
    assert.equal((f.messages[3]!.params as {cursor:string}).cursor,'page2');assert.deepEqual(f.args,['app-server','--listen','stdio://']);
    assert.equal(f.environment!.CODEX_HOME,root);assert.equal(Object.keys(f.environment!).some(k=>k.startsWith('SJ_')),false);
    assert.deepEqual(await resolveCodexSelection(SettingsSchema.parse({}),root),{model:'account-default',reasoning:'high',automatic:true});
    assert.deepEqual(await resolveCodexSelection(SettingsSchema.parse({codex_model:'alternative',codex_reasoning:'medium'}),root),{model:'alternative',reasoning:'medium',automatic:false});
  }finally{clearCodexModels(root);rmSync(root,{recursive:true,force:true});}
});
test('an absent default is reported explicitly instead of claiming a guessed model',async()=>{
  const root=profile(),f=fixture(m=>m.method==='initialize'?{id:m.id,result:{}}:m.method==='model/list'?{id:m.id,result:{data:[model('alternative')],nextCursor:null}}:undefined);
  try{await codexModels(SettingsSchema.parse({}),root,undefined,f.launch);await assert.rejects(resolveCodexSelection(SettingsSchema.parse({}),root),/尚未確認預設模型/);
  }finally{clearCodexModels(root);rmSync(root,{recursive:true,force:true});}
});
test('catalog errors and cancellation close the native child without forwarding diagnostic secrets',async()=>{
  for(const aborted of [false,true]){
    const root=profile(),controller=new AbortController(),f=fixture(m=>m.method==='initialize'?{id:m.id,result:{}}:m.method==='model/list'&&!aborted?{id:m.id,error:{message:'SJ_API_KEY=isolated-secret'}}:undefined);
    try{
      const task=codexModels(SettingsSchema.parse({}),root,controller.signal,f.launch);
      if(aborted)queueMicrotask(()=>controller.abort());
      await assert.rejects(task,error=>error instanceof Error&&!error.message.includes('isolated-secret')&&/Codex 模型查詢/.test(error.message));
      assert.equal(f.killed,true);
    }finally{clearCodexModels(root);rmSync(root,{recursive:true,force:true});}
  }
});
