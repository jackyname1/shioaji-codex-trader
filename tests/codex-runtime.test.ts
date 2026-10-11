import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Codex} from '@openai/codex-sdk';
import {bundledCodexPath,codexEnvironment,prepareCodexProfile,codexIssue} from '../src/core/codex.js';

// The hosted workspace has administrator-managed Codex hooks/network requirements; it cannot run a standalone SDK session.
// CI exercises the real executable on both clean Linux and Windows runners, without weakening those host requirements.
const managedHost=!process.env.CI&&process.platform==='linux'&&existsSync('/etc/codex/requirements.toml');
test('bundled Codex executes a structured response through a loopback-only provider without any real authentication',
  {timeout:40000,skip:managedHost?'Standalone native verification runs on clean CI runners; hosted Codex requirements remain enforced':false},async()=>{
  // Codex refuses to create its native helper aliases beneath an OS temporary directory.
  const root=mkdtempSync(join(process.cwd(),'codex-native-isolated-'));let requests=0;const stages:string[]=[];
  const message={id:'msg_isolated',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'{"ok":true}',annotations:[]}]};
  const response={id:'resp_isolated',object:'response',created_at:1,status:'completed',model:'isolated-model',output:[message],
    usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/responses'){res.writeHead(404);res.end();return;}
    let body='';for await(const chunk of req)body+=String(chunk);
    const input=JSON.parse(body);requests++;assert.equal(input.model,'isolated-model');
    assert.deepEqual(input.text.format.schema.required,['ok']);
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'{"ok":true}'},
      {type:'response.output_text.done',item_id:message.id,output_index:0,content_index:0,text:'{"ok":true}'},
      {type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}];
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(events.map((event,i)=>'data: '+JSON.stringify({...event,sequence_number:i})+'\n\n').join(''));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const source={...process.env};delete source.OPENAI_API_KEY;delete source.CODEX_API_KEY;
  const env={...codexEnvironment(source,root),NO_PROXY:'127.0.0.1,localhost'};
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
  try{
    prepareCodexProfile(root,join(root,'empty-source'));
    const codex=new Codex({codexPathOverride:bundledCodexPath(),env,config:{model_provider:'isolated',
      model_providers:{isolated:{name:'Isolated loopback fixture',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false}}}});
    const thread=codex.startThread({model:'isolated-model',workingDirectory:root,skipGitRepoCheck:true,sandboxMode:'read-only',webSearchMode:'disabled',networkAccessEnabled:false,approvalPolicy:'never'});
    const result=await thread.runStreamed('Use no tools. Return {"ok":true}.',{signal:abort.signal,outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});
    let answer='',completed=false;
    for await(const event of result.events){stages.push(event.type);
      if('item' in event){assert.ok(!['command_execution','file_change','mcp_tool_call','web_search'].includes(event.item.type));
        if(event.type==='item.completed'&&event.item.type==='agent_message')answer=event.item.text;}
      if(event.type==='turn.completed')completed=true;
      if(event.type==='turn.failed')throw new Error(event.error.message);
    }
    assert.equal(completed,true);assert.deepEqual(JSON.parse(answer),{ok:true});assert.equal(requests,1);
  }catch(error){throw new Error(`Isolated native runtime: requests=${requests}; stages=${stages.join(',')}; ${codexIssue(error)}`);
  }finally{clearTimeout(timer);abort.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
