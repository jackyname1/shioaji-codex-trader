import { z } from 'zod';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { brokerOrigin,BUNDLED_SHIOAJI_VERSION } from './broker-runtime.js';
import { BrokerHealthSchema, marketReady,BrokerError } from '../broker/health.js';
import {RequestDiagnostics,type BrokerDiagnostics} from '../broker/diagnostics.js';
import {NativeStartup} from './native-startup.js';

export const ConnectionInputSchema = z.strictObject({
  api_key: z.string().trim().min(1).max(4096), secret_key: z.string().trim().min(1).max(4096),
  ca_path: z.string().max(4096).default(''), ca_password: z.string().max(4096).default(''),
  remember: z.boolean().default(true),
}).refine(x => (!x.ca_path && !x.ca_password) || (!!x.ca_path && !!x.ca_password), 'CA 憑證與密碼需一起填寫');
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;
export const ConnectionUpdateSchema=z.strictObject({api_key:z.string().trim().max(4096).default(''),secret_key:z.string().trim().max(4096).default(''),
  ca_path:z.string().max(4096).default(''),ca_password:z.string().max(4096).default(''),remember:z.boolean().default(true)});
export function connectionInput(raw:unknown,saved?:ConnectionInput):ConnectionInput {
  const update=ConnectionUpdateSchema.parse(raw);
  if(!update.api_key&&!update.secret_key&&saved)return ConnectionInputSchema.parse({...saved,remember:update.remember,
    ...(update.ca_path||update.ca_password?{ca_path:update.ca_path,ca_password:update.ca_password}:{})});
  return ConnectionInputSchema.parse(update);
}
export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string }
export interface CredentialState { remembered:boolean; state:'empty'|'saved'|'unavailable'|'unreadable'; message:string }
export class CredentialError extends Error {}
export class CredentialVault {
  constructor(readonly root: string, private storage: SecretStorage) {}
  async status():Promise<CredentialState>{
    const exists=await stat(join(this.root,'connection.vault')).then(s=>s.isFile(),()=>false);
    if(!this.storage.isEncryptionAvailable())return {remembered:false,state:'unavailable',message:'系統加密暫時無法使用，設定尚未保存'};
    if(!exists)return {remembered:false,state:'empty',message:'尚未保存登入設定'};
    if(!await this.read())return {remembered:false,state:'unreadable',message:'已保存的設定無法解密，請重新登入並記住設定'};
    return {remembered:true,state:'saved',message:'登入設定已加密保存，模擬與實盤共用'};
  }
  async read(): Promise<ConnectionInput | undefined> {
    if (!this.storage.isEncryptionAvailable()) return undefined;
    try { const raw = JSON.parse(this.storage.decryptString(await readFile(join(this.root, 'connection.vault'))));
      delete raw.cli_path; return ConnectionInputSchema.parse(raw); }
    catch { return undefined; }
  }
  async save(input: ConnectionInput): Promise<void> {
    if (!input.remember) { await this.clear(); return; }
    if (!this.storage.isEncryptionAvailable()) throw new CredentialError('無法使用系統加密儲存；請取消記住金鑰');
    const temporary = join(this.root, randomUUID() + '.vault.tmp');
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const encrypted=this.storage.encryptString(JSON.stringify(input));
      // Verify encryption/decryption before replacing the last valid saved login.
      if(JSON.stringify(ConnectionInputSchema.parse(JSON.parse(this.storage.decryptString(encrypted))))!==JSON.stringify(input))throw new Error('round trip');
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, join(this.root, 'connection.vault'));
    } catch {throw new CredentialError('無法加密保存登入設定；請重試登入並記住設定');}
    finally {await unlink(temporary).catch(()=>undefined);}
  }
  async clear(): Promise<void> { await unlink(join(this.root, 'connection.vault')).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new CredentialError('無法清除保存的登入設定，請確認設定目錄可寫入');}); }
}
export function brokerEnvironment(source: NodeJS.ProcessEnv, input: ConnectionInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SJ_PROXY','SJ_HOME_PATH','SJ_TIMEOUT','SJ_CONTRACTS_PATH'])
    if (source[key] !== undefined) env[key] = source[key];
  // Paper trading is local. BOTH user-facing modes use the production market-data connection.
  return { ...env, SJ_API_KEY: input.api_key, SJ_SEC_KEY: input.secret_key, SJ_PRODUCTION: 'true', NO_COLOR:'1', RUST_LOG:'warn', SJ_HTTP_AUTH:'false',
    ...(input.ca_path ? { SJ_CA_PATH: input.ca_path, SJ_CA_PASSWD: input.ca_password } : {}) };
}
export type Execute = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
const execute: Execute = async (binary, args, options) => promisify(execFile)(binary, args, { ...options, maxBuffer: 2000000 });
const NativeInfoSchema=z.object({simulation:z.literal(false),version:z.literal(BUNDLED_SHIOAJI_VERSION),instance_id:z.string().optional()});
export class NativeConnection {
  phase='idle';
  status = '輸入 API Key 與 Secret Key 即可連線';
  baseUrl = 'http://127.0.0.1:18981';
  hasCa = false;
  private healthy = false;
  private owned?: ChildProcess;
  private stop=new AbortController();
  private signature='';private identity='';private version:string|null=null;private health?:z.infer<typeof BrokerHealthSchema>;
  private caIssue='';
  private startup=new NativeStartup();private caFallback=false;private healthMalformed=false;
  private apiDenied?:number;
  private records=new RequestDiagnostics(Date.now);
  private readonly timeoutMs:number;private readonly listenerTimeoutMs:number;private readonly pollMs:number;private readonly shutdownMs:number;
  private run: Execute; private fetcher: typeof fetch; private launch: typeof spawn; private origin: () => Promise<string>;
  constructor(readonly root: string, private binary: () => Promise<string>, dependencies: {
    run?: Execute; fetcher?: typeof fetch; launch?: typeof spawn; origin?: () => Promise<string>;timeoutMs?:number;pollMs?:number;shutdownMs?:number;
  } = {}) { this.run = dependencies.run ?? execute; this.fetcher = dependencies.fetcher ?? fetch;
    this.launch = dependencies.launch ?? spawn; this.origin = dependencies.origin ?? brokerOrigin;
    this.timeoutMs=dependencies.timeoutMs??90000;this.listenerTimeoutMs=dependencies.timeoutMs??45000;this.pollMs=dependencies.pollMs??300;this.shutdownMs=dependencies.shutdownMs??3000; }
  get connected(): boolean { return this.healthy && !!this.owned && this.owned.exitCode === null; }
  get hasLoginIdentity():boolean{return !!this.identity;}
  sameLogin(input:ConnectionInput):boolean{return this.identity===createHash('sha256').update(JSON.stringify([input.api_key,input.secret_key])).digest('hex');}
  diagnostics():BrokerDiagnostics{return {version:this.version,bundled_version:BUNDLED_SHIOAJI_VERSION,stream_connected:false,generation:0,trade_cache:null,
    ...(this.health?{health:this.health}:{}),startup:{phase:this.phase,issue:this.phase==='failed'?this.status:this.caIssue,
      code:this.startup.code,elapsed_ms:this.startup.elapsedMs,process_exit_code:this.startup.exitCode,process_signal:this.startup.signal,ca_fallback:this.caFallback},endpoints:this.records.snapshot()};}
  async start(raw: unknown): Promise<ConnectionInput> {
    const input = ConnectionInputSchema.parse(raw);
    const signature=createHash('sha256').update(JSON.stringify([input.api_key,input.secret_key,input.ca_path,input.ca_password])).digest('hex');
    if(this.connected&&!this.caFallback&&this.signature===signature&&await this.available(this.baseUrl)&&this.connected)return input;
    let stage='CA',effective=input;this.caIssue='';this.caFallback=false;this.startup=new NativeStartup();
    try {
    if (input.ca_path) {
      const file = await stat(input.ca_path).catch(() => undefined);
      if (!file?.isFile() || !/\.(pfx|p12)$/i.test(input.ca_path) || file.size > 10000000){
        effective={...input,ca_path:'',ca_password:''};this.caIssue='CA 憑證無法讀取；行情與帳務仍可登入，實盤委託會繼續核對有效 CA';
      }
    }
    stage='stop';await this.close();this.resetHealth();
    this.phase='starting';this.status='正在啟動內建 Shioaji';stage='runtime';
    const binary = await this.binary(); this.baseUrl = await this.origin(); const url = new URL(this.baseUrl), port = url.port;
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !port) throw new Error('無法建立內建 Shioaji 連線');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const options = { cwd: this.root, env:brokerEnvironment(process.env,effective), timeout: 60000, windowsHide: true };
    this.status = '正在登入 Shioaji，等待行情服務就緒';
      const help = await this.run(binary, ['server', 'start', '--help'], { ...options, env: brokerEnvironment(process.env, { ...input, api_key: '', secret_key: '', ca_path: '', ca_password: '' }) });
      if (!help.stdout.includes('--no-open')) throw new Error('版本不支援');
      for(;;) {
      this.stop=new AbortController();const startup=this.startup=new NativeStartup();
      // Match Pro: use the SDK's standard home/token pool rather than a separate
      // App-owned login cache. Old App data is preserved, never deleted/migrated.
      const env={...brokerEnvironment(process.env,effective),SJ_HTTP_ADDR:'127.0.0.1:'+port,SJ_HTTP_LOG:'false',SJ_HTTP_CORS:'false',SJ_UDS_DISABLE:'true'};
      const child=this.launch(binary,['server','start','--no-open','--production'],{cwd:this.root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      this.owned=child;let failed=false,spawnError=false;
      child.stdout?.on('data',(chunk:Buffer)=>{if(this.owned===child&&this.phase==='authenticating')startup.consume('stdout',chunk);});
      child.stderr?.on('data',(chunk:Buffer)=>{if(this.owned===child&&this.phase==='authenticating')startup.consume('stderr',chunk);});
      child.on('error',()=>{failed=true;spawnError=true;});
      child.on('exit',(code,signal)=>{failed=true;if(this.owned===child){startup.exited(code,signal);this.healthy=false;
        if(this.phase==='ready'){this.phase='failed';this.status=startup.failure('PROCESS_EXIT');}}});
      stage='login';this.phase='authenticating';this.status='正在登入 Shioaji，等待行情服務就緒';
      try {
      // Pro distinguishes a listening HTTP server (/info) from a usable broker
      // session (/health). Do not confuse a live listener with authenticated data.
      let info:z.infer<typeof NativeInfoSchema>|undefined;
      const listenerDeadline=performance.now()+this.listenerTimeoutMs;
      while(performance.now()<listenerDeadline){
        this.stop.signal.throwIfAborted();if(failed)throw new Error('啟動失敗');
        try{const raw=await this.read('/info',1200);stage='info';info=NativeInfoSchema.parse(raw);stage='login';break;}
        catch(error){if(stage==='info'||error instanceof BrokerError&&[401,403].includes(error.status??0))throw error;}
        await delay(this.pollMs,undefined,{signal:this.stop.signal});
      }
      if(!info)throw new Error('HTTP 服務啟動逾時');
      this.version=info.version;this.status='Shioaji API 已啟動，正在確認登入工作階段';
      const deadline=performance.now()+this.timeoutMs; let ready=false;
      while(performance.now()<deadline) { this.stop.signal.throwIfAborted();if(failed)throw new Error('啟動失敗');if (await this.available(this.baseUrl)) {ready=true;break;}
        if(this.apiDenied)throw new BrokerError('Shioaji 本機 API 拒絕存取',false,this.apiDenied);
        await delay(this.pollMs,undefined,{signal:this.stop.signal}); }
      this.stop.signal.throwIfAborted(); if(failed)throw new Error('啟動失敗');
      if(!ready)throw new Error('登入逾時');
      if(failed||child.exitCode!==null){stage='login';throw new Error('登入程序已結束');}
      this.healthy=true;this.hasCa=!!effective.ca_path&&this.health?.ca_expired===false;
      this.signature=signature;this.version=info.version&&/^[\d.]+(?:[-\w.]*)$/.test(info.version)?info.version:null;
      this.identity=createHash('sha256').update(JSON.stringify([input.api_key,input.secret_key])).digest('hex');
      this.startup.ready();this.phase='ready';this.status = 'Shioaji 已連線 · 真實行情'; return input;
      } catch(error) {
        // Only an explicit native CA error permits one retry without the optional CA.
        // Keep saved credentials intact and never claim trading readiness after this fallback.
        if(!this.caFallback&&effective.ca_path&&this.startup.caFailure&&!this.stop.signal.aborted) {
          this.caIssue=this.startup.failure('CA_INVALID')+'；已停用本次 CA，行情與帳務仍可登入，實盤需重新核對有效 CA';
          await this.close();effective={...effective,ca_path:'',ca_password:''};this.caFallback=true;this.resetHealth();continue;
        }
        if(stage==='login')this.status=this.startup.failure(spawnError?'PROCESS_START':failed?'PROCESS_EXIT':error instanceof BrokerError&&[401,403].includes(error.status??0)?'HTTP_AUTH':this.healthMalformed?'HEALTH_SCHEMA':'STARTUP_TIMEOUT',this.health);
        throw error;
      }
      }
    } catch { const loginIssue=this.status;this.startup.discard();await this.close();this.phase='failed';this.status=stage==='CA'?'CA 憑證無法讀取，請重新選取 .pfx／.p12 檔案':stage==='runtime'
      ?'內建 Shioaji 無法啟動，請確認安裝檔完整':stage==='info'?'Shioaji 未取得正式行情服務，或內建 API 版本不符，請重新連線'
      :loginIssue;throw new BrokerError(this.status); }
  }
  private resetHealth():void {this.health=undefined;this.version=null;this.healthMalformed=false;this.apiDenied=undefined;}
  private async read(path:string,timeout:number):Promise<unknown>{
    this.records.attempt(path);
    let recorded=false;
    try{const response=await this.fetcher(this.baseUrl+'/api/v1'+path,{redirect:'error',signal:AbortSignal.timeout(timeout)});
      if(!response.ok){if([401,403].includes(response.status))this.apiDenied=response.status;
        this.records.failure(path,`Shioaji ${path} 讀取失敗（HTTP ${response.status}）`,response.status);recorded=true;await response.body?.cancel();throw new BrokerError('Shioaji 本機 API 尚未就緒',false,response.status);}
      const body:unknown=await response.json();this.records.success(path);return body;
    }catch(error){if(!recorded)this.records.failure(path,`Shioaji ${path} 尚未回應或回應格式不符`);throw error instanceof BrokerError?error:new Error('Shioaji 服務未就緒');}
  }
  private async available(baseUrl: string): Promise<boolean> {
    this.healthMalformed=false;
    try {this.health=BrokerHealthSchema.parse(await this.read('/health',1200));return marketReady(this.health);}
    catch(error) {this.healthMalformed=error instanceof z.ZodError;return false;}
  }
  async close(): Promise<void> {
    this.stop.abort();this.healthy=false;this.hasCa=false;this.signature='';this.identity='';this.phase='idle';this.status='Shioaji 尚未登入';const child=this.owned;this.owned=undefined;
    if(!child||child.exitCode!==null||child.signalCode)return;
    try{await new Promise<void>((resolve,reject)=>{
      let forceTimer:ReturnType<typeof setTimeout>|undefined;
      const done=()=>{clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);resolve();};
      const timer=setTimeout(()=>{
        // A kill request is not proof of exit. Wait for the actual process event
        // before allowing another login to acquire a token slot.
        forceTimer=setTimeout(()=>{child.removeListener('exit',done);reject(new BrokerError('內建 Shioaji 程序尚未結束，已停止重新登入以避免重複連線'));},this.shutdownMs);child.kill('SIGKILL');
      },this.shutdownMs);
      child.once('exit',done);child.kill();
    });}catch(error){this.owned=child;this.phase='failed';this.status='內建 Shioaji 程序尚未結束，已停止重新登入以避免重複連線';throw error;}
  }
}
