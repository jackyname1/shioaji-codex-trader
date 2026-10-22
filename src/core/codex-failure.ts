import {StrategyValidationError} from './strategy-admission.js';
/** Diagnostic output is an allowlist, never a copy of SDK stderr, URLs, paths or environment values. */
export type CodexFailureKind='QUOTA'|'RATE_LIMIT'|'NETWORK'|'AUTH'|'ACCESS'|'MODEL'|'RUNTIME'|'TIMEOUT'|'CANCELLED'|'OTHER';
export interface CodexFailureDetail {kind:CodexFailureKind;code:string;http_status?:number;exit_code?:number;exit_signal?:string;proxy_configured?:boolean;custom_ca_configured?:boolean;
  validation_phase?:'JSON'|'STRUCTURE'|'SEMANTIC';validation_issues?:{path:string;code:string}[]}
const rawMessage=(error:unknown):string=>{
  const parts:string[]=[];let current=error;
  for(let n=0;n<4&&current instanceof Error;n++){parts.push(current.message);current=current.cause;}
  return parts.join('\n');
};
export function diagnoseCodexFailure(error:unknown):CodexFailureDetail {
  if(error instanceof StrategyValidationError)return {kind:'OTHER',code:error.code,validation_phase:'SEMANTIC'};
  if(error instanceof CodexError)return {...error.diagnostic};
  if(error instanceof SyntaxError)return {kind:'OTHER',code:'INVALID_OUTPUT',validation_phase:'JSON'};
  if(error instanceof Error&&error.name==='ZodError'){
    // Zod messages and unrecognized_keys can contain private model text. Emit only known schema paths/codes.
    const allowed=new Set(['decisions','smart','screening','entry','snapshot_id','expires_at','stance','candidates','summary','symbol','action','shares','limit_price','entry_when','trigger_price','reason','conditions','left','right','value','operator','stop_price','take_profit','reward_target','trailing_activate','trailing_fraction','rebound_fraction','request_id','lot']);
    const rows=(error as Error&{issues?:{code:string;path:(string|number)[]}[]}).issues??[];
    return {kind:'OTHER',code:'INVALID_OUTPUT',validation_phase:rows.some(i=>i.code==='custom')?'SEMANTIC':'STRUCTURE',
      validation_issues:rows.slice(0,12).map(i=>({path:i.path.map(p=>typeof p==='number'?String(p):allowed.has(p)?p:'?').join('.'),
        code:['custom','invalid_type','invalid_value','invalid_format','too_big','too_small','unrecognized_keys'].includes(i.code)?i.code:'SCHEMA'}))};
  }
  const raw=rawMessage(error);
  if(/^Failed to parse item:/i.test(raw))return {kind:'RUNTIME',code:'STREAM_PROTOCOL'};
  if(/invalid output|未產生完整有效/.test(raw))return {kind:'OTHER',code:'INVALID_OUTPUT'};
  if(/(?:http|status|response).{0,30}\b407\b|^407\b|proxy authentication/i.test(raw))return {kind:'NETWORK',code:'PROXY_AUTH',http_status:407};
  if(/(?:http|status|response).{0,30}\b401\b|^401\b|unauthorized|not logged|refresh token|login required|authentication failed|尚未登入|登入.{0,8}(過期|失效)/i.test(raw))return {kind:'AUTH',code:'AUTH_REQUIRED'};
  if(/(?:http|status|response).{0,30}\b403\b|\b403.{0,10}forbidden/i.test(raw))return {kind:'ACCESS',code:'HTTP_403',http_status:403};
  if(/quota|usage limit|insufficient_quota|用量.{0,10}上限|額度/i.test(raw))return {kind:'QUOTA',code:'QUOTA_EXCEEDED'};
  if(/(?:http|status|response).{0,30}\b429\b|^429\b|rate limit|too many requests/i.test(raw))return {kind:'RATE_LIMIT',code:'RATE_LIMIT',http_status:429};
  if(/model.{0,100}(not found|not supported|unavailable|does not exist|does not support|not available)|(?:unsupported|unknown|invalid|not support).{0,60}model/i.test(raw))return {kind:'MODEL',code:'MODEL_UNAVAILABLE'};
  if(/reasoning.{0,100}(unsupported|not support|invalid)|unsupported.{0,60}(reasoning|effort)/i.test(raw))return {kind:'MODEL',code:'REASONING_UNSUPPORTED'};
  if(/schema|output format/i.test(raw))return {kind:'RUNTIME',code:'OUTPUT_SCHEMA_REJECTED'};
  if(/TLS|certificate|unknown issuer|invalid peer|CERT_/i.test(raw))return {kind:'NETWORK',code:'TLS_CERTIFICATE'};
  if(/ENOTFOUND|EAI_AGAIN|dns error|dns lookup|failed to lookup|name or service not known/i.test(raw))return {kind:'NETWORK',code:'DNS_FAILURE'};
  if(/ECONNREFUSED|connection refused|actively refused|10061/i.test(raw))return {kind:'NETWORK',code:'CONNECTION_REFUSED'};
  if(/ECONNRESET|connection reset|broken pipe/i.test(raw))return {kind:'NETWORK',code:'CONNECTION_RESET'};
  const status=raw.match(/(?:http|status|response).{0,30}\b(50[0-9]|52[0-9])\b/i);
  if(status)return {kind:'NETWORK',code:'HTTP_SERVER_ERROR',http_status:Number(status[1])};
  if(/stream disconnected|websocket.{0,50}(closed|failed|error)|SSE.{0,30}(disconnect|error)/i.test(raw))return {kind:'NETWORK',code:'STREAM_INTERRUPTED'};
  if(/ETIMEDOUT|connect.{0,30}timed? out|network.{0,30}timeout/i.test(raw))return {kind:'NETWORK',code:'NETWORK_TIMEOUT'};
  if(/Codex.{0,15}(回應|分析|連線測試).{0,10}逾時/i.test(raw))return {kind:'TIMEOUT',code:'CODEX_TIMEOUT'};
  if(/network|connect|fetch|網路|連線未完成/i.test(raw))return {kind:'NETWORK',code:'NETWORK_UNSPECIFIED'};
  // The SDK wraps a native process exit together with stderr. Preserve only the numeric status or known signal.
  const exit=raw.match(/Codex Exec exited with code (-?\d{1,10}):/i);
  if(exit){const code=Number(exit[1]);return {kind:'RUNTIME',code:'PROCESS_EXIT',
    ...(Number.isSafeInteger(code)&&code>=-2147483648&&code<=4294967295?{exit_code:code}:{})};}
  const signal=raw.match(/Codex Exec exited with signal (SIG[A-Z]+):/i);
  if(signal)return {kind:'RUNTIME',code:'PROCESS_SIGNAL',
    ...(['SIGINT','SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGBUS','SIGILL','SIGFPE','SIGHUP'].includes(signal[1]!.toUpperCase())?{exit_signal:signal[1]!.toUpperCase()}:{})};
  if(/spawn.{0,200}(ENOENT|ENOTDIR)|原生執行檔未安裝|Cannot find module|Could not locate Codex/i.test(raw))return {kind:'RUNTIME',code:'EXECUTABLE_MISSING'};
  if(/sandbox|CreateProcess|os error|EACCES|EPERM|ENOEXEC|permission denied|access.{0,10}denied/i.test(raw))return {kind:'RUNTIME',code:'EXECUTABLE_FAILED'};
  return {kind:'OTHER',code:'OTHER'};
}
export class CodexError extends Error {
  readonly kind:CodexFailureKind;readonly diagnostic:CodexFailureDetail;
  constructor(message:string,kind?:CodexFailureKind,diagnostic?:CodexFailureDetail){
    super(message);const detail=diagnostic??diagnoseCodexFailure(new Error(message));
    this.kind=kind??detail.kind;this.diagnostic={...detail,kind:this.kind};
  }
}
/** Terminal SDK events are execution failures even when their private message has no known keyword. */
export function codexEventError(message:string,code:'TURN_FAILED'|'STREAM_ERROR'|'ITEM_ERROR'):CodexError {
  const diagnostic=diagnoseCodexFailure(new Error(message));
  if(diagnostic.kind==='OTHER'&&diagnostic.code==='OTHER'){diagnostic.kind='RUNTIME';diagnostic.code=code;}
  return new CodexError(codexFailureMessage(diagnostic)||'Codex 回合未回傳有效結果，請匯出完整紀錄核對',diagnostic.kind,diagnostic);
}
export const codexFailureKind=(error:unknown):CodexFailureKind=>diagnoseCodexFailure(error).kind;
export const shouldHaltCodex=(error:unknown):boolean=>!['OTHER','CANCELLED'].includes(codexFailureKind(error));
export function codexNetworkContext(env:NodeJS.ProcessEnv):Pick<CodexFailureDetail,'proxy_configured'|'custom_ca_configured'> {
  const present=new Set(Object.entries(env).filter(([,v])=>!!v).map(([k])=>k.toUpperCase()));
  return {proxy_configured:['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].some(k=>present.has(k)),
    custom_ca_configured:['CODEX_CA_CERTIFICATE','SSL_CERT_FILE'].some(k=>present.has(k))};
}
export function codexFailureMessage(d:CodexFailureDetail):string {
  const network:Record<string,string>={PROXY_AUTH:'代理伺服器要求驗證',TLS_CERTIFICATE:'TLS 憑證驗證失敗',DNS_FAILURE:'DNS 無法解析',
    CONNECTION_REFUSED:'連線被拒絕',CONNECTION_RESET:'連線被重設',HTTP_SERVER_ERROR:`服務回應 HTTP ${d.http_status}`,STREAM_INTERRUPTED:'回應串流中斷',NETWORK_TIMEOUT:'連線逾時',NETWORK_UNSPECIFIED:'連線未完成'};
  if(d.kind==='NETWORK')return `Codex 網路連線未完成（${network[d.code]??'連線未完成'}）；請測試連線並匯出最新 Codex 記錄，核對代理、VPN、憑證或服務狀態`;
  if(d.kind==='AUTH')return 'Codex 尚未登入或登入已過期，請按登入重新連接';
  if(d.kind==='ACCESS')return 'Codex 服務拒絕存取（HTTP 403）；請核對登入權限或網路代理，再測試連線';
  if(d.kind==='QUOTA')return 'Codex 使用額度暫時不足，請稍後重試或檢查訂閱額度';
  if(d.kind==='RATE_LIMIT')return 'Codex 呼叫遭限流（HTTP 429），請稍後測試連線';
  if(d.kind==='MODEL')return d.code==='REASONING_UNSUPPORTED'?'Codex 模型不支援此推理強度，請使用模型預設':'Codex 模型不可用，請清空模型欄位使用帳戶預設模型';
  if(d.kind==='RUNTIME'){
    const runtime:Record<string,string>={PROCESS_EXIT:`子程序提前退出${d.exit_code===undefined?'':`，退出碼 ${d.exit_code}`}`,
      PROCESS_SIGNAL:`子程序被終止${d.exit_signal?`，訊號 ${d.exit_signal}`:''}`,EXECUTABLE_MISSING:'找不到原生執行檔，請重新下載完整版本',
      EXECUTABLE_FAILED:'本機執行環境未能啟動，請重開程式',STREAM_PROTOCOL:'子程序回應串流格式異常',
      OUTPUT_SCHEMA_REJECTED:'服務拒絕輸出格式',TURN_FAILED:'模型回合失敗',STREAM_ERROR:'模型串流回報錯誤',ITEM_ERROR:'模型回傳錯誤項目',
      EMPTY_OUTPUT:'回合結束但沒有分析結果',TOOL_REJECTED:'模型嘗試使用禁止的工具',SDK_FAILURE:'SDK 執行中斷'};
    return `Codex 執行中斷（${runtime[d.code]??'執行失敗'}）；已停止自動呼叫，請測試連線或匯出完整紀錄核對`;
  }
  if(d.kind==='TIMEOUT')return 'Codex 回應逾時；既有保護條件保留，未確認數量不送單';
  if(d.kind==='CANCELLED')return 'Codex 已停止；既有保護條件保留，未確認數量不送單';
  return '';
}
