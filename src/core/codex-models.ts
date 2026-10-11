import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { bundledCodexPath, codexEnvironment, prepareCodexProfile, CodexError } from './codex.js';
import type { Settings } from './models.js';

export const CodexModelSchema=z.object({
  id:z.string(),model:z.string().min(1),displayName:z.string().default(''),isDefault:z.boolean().default(false),
  defaultReasoningEffort:z.string().default('default'),hidden:z.boolean().default(false),
  supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string(),description:z.string().default('')})).default([]),
});
export type CodexModel=z.infer<typeof CodexModelSchema>;
export interface CodexSelection {model:string;reasoning:string;automatic:boolean}
const cached=new Map<string,{at:number;models:CodexModel[]}>();
export function clearCodexModels(profile:string):void {for(const key of cached.keys())if(key.startsWith(profile+'\n'))cached.delete(key);}
/** Native model/list is catalog discovery only; a completed inference turn still verifies access. */
export async function codexModels(settings:Pick<Settings,'codex_path'>,profile:string,signal?:AbortSignal,
  launch:typeof spawn=spawn):Promise<CodexModel[]> {
  const binary=settings.codex_path||bundledCodexPath(),key=profile+'\n'+binary,old=cached.get(key);
  if(old&&Date.now()-old.at<10*60000)return old.models;
  prepareCodexProfile(profile);
  const models=await new Promise<CodexModel[]>((resolve,reject)=>{
    let child:ChildProcessWithoutNullStreams|undefined,buffer='',finished=false,requestId=2;
    const collected:CodexModel[]=[],cursors=new Set<string>();
    const stop=(error?:unknown,result?:CodexModel[]):void=>{
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      child?.kill();if(error)reject(error);else resolve(result!);
    };
    const abort=():void=>stop(new CodexError('Codex 模型查詢已停止'));
    const timer=setTimeout(()=>stop(new CodexError('Codex 模型查詢逾時，請測試連線或指定模型')),20000);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    try {
      child=launch(binary,['app-server','--listen','stdio://'],{env:codexEnvironment(process.env,profile),windowsHide:true,stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
      child.on('error',()=>stop(new CodexError('Codex 模型查詢無法啟動')));
      child.on('exit',()=>stop(new CodexError('Codex 模型查詢未完成')));
      child.stderr.on('data',()=>{/* Native diagnostics may contain paths or authentication information. */});
      const send=(message:unknown):void=>{if(!finished)child!.stdin.write(JSON.stringify(message)+'\n');};
      child.stdin.on('error',()=>stop(new CodexError('Codex 模型查詢連線中斷')));
      child.stdout.on('data',chunk=>{
        buffer+=String(chunk);if(buffer.length>2000000){stop(new CodexError('Codex 模型資料過大'));return;}
        for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try {const message=JSON.parse(line) as {id?:number;error?:unknown;result?:unknown};
            if(message.error){stop(new CodexError('Codex 模型查詢尚未通過'));return;}
            if(message.id===1){send({method:'initialized',params:{}});send({id:2,method:'model/list',params:{limit:100,includeHidden:false}});}
            if(message.id===requestId){const page=z.object({data:z.array(CodexModelSchema),nextCursor:z.string().nullable().optional()}).parse(message.result);
              collected.push(...page.data);
              if(page.nextCursor){
                if(cursors.has(page.nextCursor)||collected.length>1000){stop(new CodexError('Codex 模型分頁資料未通過'));return;}
                cursors.add(page.nextCursor);send({id:++requestId,method:'model/list',params:{limit:100,includeHidden:false,cursor:page.nextCursor}});
              }else{
                if(!collected.length){stop(new CodexError('Codex 未提供模型清單'));return;}
                stop(undefined,[...new Map(collected.map(m=>[m.model,m])).values()]);return;
              }
            }
          }catch{stop(new CodexError('Codex 模型資料格式未通過'));return;}
        }
      });
      send({id:1,method:'initialize',params:{clientInfo:{name:'shioaji_codex_trader',title:'Shioaji Codex Trader',version:'0.1.0'}}});
    }catch{stop(new CodexError('Codex 模型查詢無法啟動'));}
  });
  cached.set(key,{at:Date.now(),models});return models;
}
export async function resolveCodexSelection(settings:Pick<Settings,'codex_model'|'codex_reasoning'|'codex_path'>,
  profile:string,signal?:AbortSignal):Promise<CodexSelection> {
  let catalog:CodexModel[]=[];
  try{catalog=await codexModels(settings,profile,signal);}catch(error){if(!settings.codex_model)throw error;signal?.throwIfAborted();}
  const selected=settings.codex_model?catalog.find(m=>m.model===settings.codex_model):catalog.find(m=>m.isDefault);
  const model=settings.codex_model||selected?.model;
  if(!model)throw new CodexError('Codex 尚未確認預設模型，請測試連線或指定模型');
  return {model,reasoning:settings.codex_reasoning==='default'?selected?.defaultReasoningEffort??'default':settings.codex_reasoning,automatic:!settings.codex_model};
}
