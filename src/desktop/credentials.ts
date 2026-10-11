import { z } from 'zod';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { brokerOrigin } from './broker-runtime.js';

export const ConnectionInputSchema = z.strictObject({
  api_key: z.string().min(1).max(4096), secret_key: z.string().min(1).max(4096),
  ca_path: z.string().max(4096).default(''), ca_password: z.string().max(4096).default(''),
  remember: z.boolean().default(false),
}).refine(x => (!x.ca_path && !x.ca_password) || (!!x.ca_path && !!x.ca_password), 'CA 憑證與密碼需一起填寫');
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;
export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string }
export class CredentialVault {
  constructor(readonly root: string, private storage: SecretStorage) {}
  async read(): Promise<ConnectionInput | undefined> {
    if (!this.storage.isEncryptionAvailable()) return undefined;
    try { const raw = JSON.parse(this.storage.decryptString(await readFile(join(this.root, 'connection.vault'))));
      delete raw.cli_path; return ConnectionInputSchema.parse(raw); }
    catch { return undefined; }
  }
  async save(input: ConnectionInput): Promise<void> {
    if (!input.remember) { await this.clear(); return; }
    if (!this.storage.isEncryptionAvailable()) throw new Error('無法使用系統加密儲存；請取消記住金鑰');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, randomUUID() + '.vault.tmp');
    await writeFile(temporary, this.storage.encryptString(JSON.stringify(input)), { mode: 0o600 });
    await rename(temporary, join(this.root, 'connection.vault'));
  }
  async clear(): Promise<void> { await unlink(join(this.root, 'connection.vault')).catch(() => undefined); }
}
export function brokerEnvironment(source: NodeJS.ProcessEnv, input: ConnectionInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])
    if (source[key] !== undefined) env[key] = source[key];
  // Paper trading is local. BOTH user-facing modes use the production market-data connection.
  return { ...env, SJ_API_KEY: input.api_key, SJ_SEC_KEY: input.secret_key, SJ_PRODUCTION: 'true',
    ...(input.ca_path ? { SJ_CA_PATH: input.ca_path, SJ_CA_PASSWD: input.ca_password } : {}) };
}
export type Execute = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
const execute: Execute = async (binary, args, options) => promisify(execFile)(binary, args, { ...options, maxBuffer: 2000000 });
export class NativeConnection {
  status = '輸入 API Key 與 Secret Key 即可連線';
  baseUrl = 'http://127.0.0.1:18981';
  hasCa = false;
  private healthy = false;
  private owned?: ChildProcess;
  private stop=new AbortController();
  private run: Execute; private fetcher: typeof fetch; private launch: typeof spawn; private origin: () => Promise<string>;
  constructor(readonly root: string, private binary: () => Promise<string>, dependencies: {
    run?: Execute; fetcher?: typeof fetch; launch?: typeof spawn; origin?: () => Promise<string>;
  } = {}) { this.run = dependencies.run ?? execute; this.fetcher = dependencies.fetcher ?? fetch;
    this.launch = dependencies.launch ?? spawn; this.origin = dependencies.origin ?? brokerOrigin; }
  get connected(): boolean { return this.healthy && !!this.owned && this.owned.exitCode === null; }
  async start(raw: unknown): Promise<ConnectionInput> {
    const input = ConnectionInputSchema.parse(raw);
    if (input.ca_path) {
      const file = await stat(input.ca_path).catch(() => undefined);
      if (!file?.isFile() || !/\.(pfx|p12)$/i.test(input.ca_path) || file.size > 10000000) throw new Error('CA 憑證需為有效的 .pfx 或 .p12 檔案');
    }
    await this.close();
    const binary = await this.binary(); this.baseUrl = await this.origin(); const url = new URL(this.baseUrl), port = url.port;
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !port) throw new Error('無法建立內建 Shioaji 連線');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const env = {...brokerEnvironment(process.env,input),SJ_HTTP_ADDR:'127.0.0.1:'+port,SJ_HOME_PATH:this.root,SJ_HTTP_LOG:'false',SJ_HTTP_CORS:'false',SJ_UDS_DISABLE:'true'}, options = { cwd: this.root, env, timeout: 60000, windowsHide: true };
    this.status = '正在連接 Shioaji，驗證真實行情與 CA';
    try {
      const help = await this.run(binary, ['server', 'start', '--help'], { ...options, env: brokerEnvironment(process.env, { ...input, api_key: '', secret_key: '', ca_path: '', ca_password: '' }) });
      if (!help.stdout.includes('--no-open')) throw new Error('版本不支援');
      this.stop=new AbortController();
      const child=this.launch(binary,['server','start','--no-open'],{cwd:this.root,env,windowsHide:true,stdio:'ignore'});
      this.owned=child;let failed=false;child.on('error',()=>{failed=true;});
      child.on('exit',()=>{failed=true;if(this.owned===child){this.healthy=false;this.status='Shioaji 已斷線，請重新連線';}});
      const deadline=Date.now()+90000;
      while(Date.now()<deadline) { this.stop.signal.throwIfAborted();if(failed)throw new Error('啟動失敗');if (await this.available(this.baseUrl)) break; await delay(300,undefined,{signal:this.stop.signal}); }
      this.stop.signal.throwIfAborted(); if(failed)throw new Error('啟動失敗');
      const response = await this.fetcher(this.baseUrl + '/api/v1/info', { redirect: 'error', signal: AbortSignal.timeout(8000) });
      const info = z.object({ simulation: z.literal(false) }).parse(await response.json());
      if (!response.ok || info.simulation !== false) throw new Error('沒有真實行情');
      this.healthy=true;this.hasCa=!!input.ca_path;
      this.status = 'Shioaji 已連線 · 真實行情'; return input;
    } catch { await this.close(); this.status = '連線未完成；請核對 API 權限、IP 與 CA'; throw new Error(this.status); }
  }
  private async available(baseUrl: string): Promise<boolean> {
    try { const r = await this.fetcher(baseUrl + '/api/v1/info', { redirect: 'error', signal: AbortSignal.timeout(1200) }); await r.body?.cancel(); return r.ok; }
    catch { return false; }
  }
  async close(): Promise<void> {
    this.stop.abort();this.healthy=false;this.hasCa=false;const child=this.owned;this.owned=undefined;
    if(!child||child.exitCode!==null)return;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();
    });
  }
}
