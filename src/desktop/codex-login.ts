import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { bundledCodexPath, codexEnvironment, prepareCodexProfile, codexThread, codexIssue, CodexError,diagnoseCodexFailure } from '../core/codex.js';
import type { Settings } from '../core/models.js';
import type { ThreadEvent } from '@openai/codex-sdk';
import { resolveCodexSelection,clearCodexModels,codexModels,type CodexModel,type CodexSelection } from '../core/codex-models.js';
import {codexEventError,codexFailureMessage} from '../core/codex-failure.js';

export interface CodexLoginState {
  state:'checking'|'signed_out'|'pending'|'ready'|'error'; message:string; can_open:boolean; device_code:string; testing:boolean;
  test_state:'untested'|'connected'|'failed';
  model?:string;reasoning?:string;
}
type Run = (binary:string,args:string[],options:{env:NodeJS.ProcessEnv;windowsHide:boolean;timeout:number}) => Promise<unknown>;
type Launch = (binary:string,args:string[],options:SpawnOptions) => ChildProcess;
export function loginUrl(raw:string): string | undefined {
  try {
    const url = new URL(raw);
    if(url.protocol!=='https:' || url.username || url.password || url.port) return;
    if(url.hostname==='auth.openai.com' && /^\/(?:oauth\/authorize|codex\/device|api\/accounts\/deviceauth)(?:\/|$)/.test(url.pathname)) return url.href;
    if(url.hostname==='chatgpt.com' && /^\/deviceauth(?:\/|$)/.test(url.pathname)) return url.href;
  } catch { /* Never open an arbitrary URL printed by a child process. */ }
}
export class CodexLogin {
  catalog:CodexModel[]=[];
  readonly status:CodexLoginState={state:'checking',message:'正在檢查 Codex 登入',can_open:false,device_code:'',testing:false,test_state:'untested'};
  private task?:Promise<void>; private child?:ChildProcess; private url?:string; private closed=false; private testAbort?:AbortController;
  private readonly run:Run; private readonly launch:Launch; private readonly binary:()=>string;
  private readonly timeout:number;
  private probeSettings?:string;
  constructor(readonly profile:string,private readonly open:(url:string)=>Promise<void>,private readonly onReady:()=>Promise<void>,
    private readonly dependencies:{run?:Run;launch?:Launch;binary?:()=>string;sourceProfile?:string;timeout?:number;
      probe?:(settings:Settings,signal:AbortSignal)=>Promise<AsyncIterable<ThreadEvent>>;settings?:()=>Settings}={}) {
    this.run=dependencies.run??((binary,args,options)=>promisify(execFile)(binary,args,{...options,maxBuffer:20000}));
    this.launch=dependencies.launch??spawn;this.binary=dependencies.binary??bundledCodexPath;this.timeout=dependencies.timeout??300000;
  }
  private env():Record<string,string>{return codexEnvironment(process.env,this.profile);}
  async check():Promise<boolean>{
    if(this.task)return false;
    const ready=await this.verify();
    if(ready&&this.dependencies.settings&&!this.status.testing){const settings=this.dependencies.settings();
      if(this.probeSettings!==this.settingsKey(settings))this.status.test_state='untested';
      if(this.status.test_state==='untested')void this.test(settings).catch(()=>undefined);}
    return ready;
  }
  private settingsKey(settings:Settings):string{return JSON.stringify([settings.codex_model,settings.codex_reasoning,settings.codex_path]);}
  private async verify():Promise<boolean>{
    if(this.closed)return false;
    try {
      prepareCodexProfile(this.profile,this.dependencies.sourceProfile);
      await this.run(this.binary(),['-c','cli_auth_credentials_store="file"','login','status'],{env:this.env(),windowsHide:true,timeout:15000});
      if(this.closed)return false;
      this.status.state='ready';if(this.status.test_state==='untested')this.status.message='Codex 已登入 · 模擬與實盤共用';
      this.status.device_code='';this.status.can_open=false;this.url=undefined;
      await this.onReady().catch(()=>undefined);return true;
    } catch {
      if(!this.closed){this.status.state='signed_out';this.status.message='Codex 尚未登入，按登入即可開啟官方登入頁';}return false;
    }
  }
  start(device=false):string{
    if(this.task)return this.status.message;
    const force=device||this.status.state==='ready'||this.status.state==='error';
    this.status.test_state='untested';
    clearCodexModels(this.profile);this.catalog=[];delete this.status.model;delete this.status.reasoning;
    this.status.state='checking';this.status.message='正在檢查 Codex 登入';
    this.task=(async()=>{
      if(!force && await this.verify())return;
      if(this.closed)return;
      prepareCodexProfile(this.profile,this.dependencies.sourceProfile);
      this.status.state='pending';this.status.message=device?'正在取得官方裝置登入代碼':'正在開啟官方 Codex 登入頁';
      this.status.device_code='';this.status.can_open=false;this.url=undefined;
      const success=await this.login(device);
      if(this.closed)return;
      if(!success || !await this.verify())throw new Error('login failed');
    })().catch(()=>{
      if(!this.closed){this.status.state='error';this.status.message='Codex 登入未完成；可重新登入，或使用裝置登入';this.status.can_open=false;this.status.device_code='';this.url=undefined;}
    }).finally(()=>{this.task=undefined;
      if(!this.closed&&this.status.state==='ready'&&this.dependencies.settings)void this.test(this.dependencies.settings()).catch(()=>undefined);});
    return this.status.message;
  }
  private login(device:boolean):Promise<boolean>{
    return new Promise(resolve=>{
      const child=this.launch(this.binary(),['-c','cli_auth_credentials_store="file"','login',...(device?['--device-auth']:[])],
        {env:this.env(),windowsHide:true,stdio:['ignore','pipe','pipe']});
      this.child=child;let output='',opened=false,finished=false;
      const finish=(success:boolean):void=>{if(finished)return;finished=true;clearTimeout(timer);this.child=undefined;resolve(success);};
      const timer=setTimeout(()=>{child.kill();finish(false);},this.timeout);
      child.once('error',()=>finish(false));child.once('close',code=>finish(code===0));
      const collect=(chunk:Buffer):void=>{
        // Keep the process output private; expose only an allowlisted login URL and a device code.
        output=(output+chunk.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'')).slice(-20000);
        for(const raw of output.match(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g)??[]){const safe=loginUrl(raw);if(!safe)continue;
          this.url=safe;this.status.can_open=true;
          this.status.message=device?'請在官方頁面輸入裝置代碼；完成後會自動連接':'請在瀏覽器完成登入；完成後會自動連接';
          if(!opened){opened=true;void this.open(safe).catch(()=>{this.status.message='請按「開啟登入頁」在瀏覽器完成登入';});}
        }
        if(device){const code=/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/.exec(output)?.[0];if(code)this.status.device_code=code;}
      };
      child.stdout?.on('data',collect);child.stderr?.on('data',collect);
    });
  }
  async reopen():Promise<string>{
    if(!this.url || this.status.state!=='pending')throw new CodexError('Codex 尚未開始登入，請先按登入');
    await this.open(this.url);return '已開啟官方 Codex 登入頁';
  }
  async test(settings:Settings):Promise<string>{
    if(this.status.testing||this.task)throw new CodexError('Codex 登入或連線測試仍在進行');
    this.probeSettings=this.settingsKey(settings);
    let timedOut=false,toolRejected=false;
    this.status.testing=true;const controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort();},60000);
    this.testAbort=controller;
    try{
      if(!await this.verify())throw new CodexError('Codex 尚未登入，請先按登入');
      this.status.message='正在測試 Codex 模型連線';
      const selection:CodexSelection=this.dependencies.probe?{model:settings.codex_model||'注入測試模型',reasoning:settings.codex_reasoning,automatic:!settings.codex_model}:
        await resolveCodexSelection(settings,this.profile,controller.signal);
      this.status.model=selection.model;this.status.reasoning=selection.reasoning;
      if(!this.dependencies.probe)this.catalog=await codexModels(settings,this.profile,controller.signal);
      const events=this.dependencies.probe?await this.dependencies.probe(settings,controller.signal):
        (await codexThread(settings,this.profile,join(this.profile,'connection-test'),selection).runStreamed('This is a connection test. Use no tools. Return {"ok":true}.',{
        signal:controller.signal,outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}})).events;
      let response='',complete=false;
      for await(const event of events){
        if('item' in event && ['command_execution','file_change','mcp_tool_call','web_search'].includes(event.item.type)){toolRejected=true;controller.abort();throw new CodexError('Codex 連線測試嘗試使用工具，已停止','RUNTIME',{kind:'RUNTIME',code:'TOOL_REJECTED'});}
        if(event.type==='item.completed'&&event.item.type==='agent_message')response=event.item.text;
        if('item' in event&&event.item.type==='error')throw codexEventError(event.item.message,'ITEM_ERROR');
        if(event.type==='turn.failed')throw codexEventError(event.error.message,'TURN_FAILED');if(event.type==='error')throw codexEventError(event.message,'STREAM_ERROR');
        if(event.type==='turn.completed')complete=true;
      }
      controller.signal.throwIfAborted();
      if(!complete)throw new CodexError(codexFailureMessage({kind:'NETWORK',code:'STREAM_INTERRUPTED'}),'NETWORK',{kind:'NETWORK',code:'STREAM_INTERRUPTED'});
      if(!response)throw new CodexError(codexFailureMessage({kind:'RUNTIME',code:'EMPTY_OUTPUT'}),'RUNTIME',{kind:'RUNTIME',code:'EMPTY_OUTPUT'});
      if(JSON.parse(response)?.ok!==true)throw new Error('invalid output');
      this.status.test_state='connected';this.status.message='Codex 連線測試成功';return this.status.message;
    }catch(error){
      const diagnostic=diagnoseCodexFailure(error);
      if(diagnostic.kind==='OTHER'&&diagnostic.code==='OTHER'){diagnostic.kind='RUNTIME';diagnostic.code='SDK_FAILURE';}
      if(controller.signal.aborted&&!toolRejected){diagnostic.kind=timedOut?'TIMEOUT':'CANCELLED';diagnostic.code=timedOut?'CODEX_TIMEOUT':'CODEX_CANCELLED';}
      this.status.test_state='failed';this.status.message=codexFailureMessage(diagnostic)||codexIssue(error);
      if(/尚未登入|登入已過期/.test(this.status.message))this.status.state='error';
      throw new CodexError(this.status.message,diagnostic.kind,diagnostic);}
    finally{clearTimeout(timer);this.status.testing=false;this.testAbort=undefined;}
  }
  async wait():Promise<void>{await this.task;}
  close():void{this.closed=true;this.child?.kill();this.testAbort?.abort();this.url=undefined;this.status.can_open=false;}
}

