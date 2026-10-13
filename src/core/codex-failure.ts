/** Diagnostic output is an allowlist, never a copy of SDK stderr, URLs, paths or environment values. */
export type CodexFailureKind='QUOTA'|'RATE_LIMIT'|'NETWORK'|'AUTH'|'ACCESS'|'MODEL'|'TIMEOUT'|'CANCELLED'|'OTHER';
export interface CodexFailureDetail {kind:CodexFailureKind;code:string;http_status?:number;proxy_configured?:boolean;custom_ca_configured?:boolean}
const rawMessage=(error:unknown):string=>{
  const parts:string[]=[];let current=error;
  for(let n=0;n<4&&current instanceof Error;n++){parts.push(current.message);current=current.cause;}
  return parts.join('\n');
};
export function diagnoseCodexFailure(error:unknown):CodexFailureDetail {
  if(error instanceof CodexError)return {...error.diagnostic};
  if(error instanceof SyntaxError||error instanceof Error&&error.name==='ZodError')return {kind:'OTHER',code:'INVALID_OUTPUT'};
  const raw=rawMessage(error);
  if(/(?:http|status|response).{0,30}\b407\b|^407\b|proxy authentication/i.test(raw))return {kind:'NETWORK',code:'PROXY_AUTH',http_status:407};
  if(/(?:http|status|response).{0,30}\b401\b|^401\b|unauthorized|not logged|refresh token|login required|authentication failed|尚未登入|登入.{0,8}(過期|失效)/i.test(raw))return {kind:'AUTH',code:'AUTH_REQUIRED'};
  if(/(?:http|status|response).{0,30}\b403\b|\b403.{0,10}forbidden/i.test(raw))return {kind:'ACCESS',code:'HTTP_403',http_status:403};
  if(/quota|usage limit|insufficient_quota|用量.{0,10}上限|額度/i.test(raw))return {kind:'QUOTA',code:'QUOTA_EXCEEDED'};
  if(/(?:http|status|response).{0,30}\b429\b|^429\b|rate limit|too many requests/i.test(raw))return {kind:'RATE_LIMIT',code:'RATE_LIMIT',http_status:429};
  if(/model.{0,100}(not found|not supported|unavailable|does not exist|does not support|not available)|(?:unsupported|unknown|invalid|not support).{0,60}model/i.test(raw))return {kind:'MODEL',code:'MODEL_UNAVAILABLE'};
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
  return {kind:'OTHER',code:'OTHER'};
}
export class CodexError extends Error {
  readonly kind:CodexFailureKind;readonly diagnostic:CodexFailureDetail;
  constructor(message:string,kind?:CodexFailureKind,diagnostic?:CodexFailureDetail){
    super(message);const detail=diagnostic??diagnoseCodexFailure(new Error(message));
    this.kind=kind??detail.kind;this.diagnostic={...detail,kind:this.kind};
  }
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
  if(d.kind==='MODEL')return 'Codex 模型不可用，請清空模型欄位使用帳戶預設模型';
  if(d.kind==='TIMEOUT')return 'Codex 回應逾時；既有保護條件保留，未確認數量不送單';
  if(d.kind==='CANCELLED')return 'Codex 已停止；既有保護條件保留，未確認數量不送單';
  return '';
}
