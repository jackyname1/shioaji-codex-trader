import type {BrokerHealth} from '../broker/health.js';

const issues = {
  CA_PASSWORD: 'CA 憑證密碼不符，請重新輸入憑證密碼',
  CA_EXPIRED: 'CA 憑證已到期，請更新憑證',
  CA_INVALID: 'CA 憑證無法載入，請重新選取有效憑證',
  SIGN_TIME: 'Shioaji 登入簽章未通過時間驗證，可按「校時並重新登入」修復',
  AUTH_REJECTED: 'Shioaji 拒絕登入，請核對 API 金鑰、正式環境權限及允許的 IP',
  PUBLIC_IP: 'Shioaji 無法取得對外 IP，請檢查網路及代理設定後重試',
  SESSION_BUSY: 'Shioaji 登入工作階段仍被使用，請從系統匣完全結束舊版及其他 Shioaji 程式後重試',
  SESSION_INVALID: 'Shioaji 登入快取無法使用，請完全結束程式後重試；設定與交易紀錄仍保留',
  PORT_IN_USE: 'Shioaji 本機連接埠被占用，請完全結束舊版後重試',
  NETWORK_TLS: 'Shioaji 網路憑證驗證失敗，請檢查系統時間、代理及網路憑證',
  NETWORK_DNS: 'Shioaji 無法解析服務位址，請檢查網路與 DNS 後重試',
  PROCESS_START: '內建 Shioaji 程序無法啟動，請檢查程式是否被防毒隔離或阻擋',
  PROCESS_EXIT: '內建 Shioaji 程序在登入完成前結束，請查看連線診斷中的退出碼',
  HEALTH_SCHEMA: 'Shioaji 健康檢查回應格式不符，請匯出連線診斷',
  SESSION_RECOVERING: 'Shioaji 工作階段仍在恢復，請稍後重新連線',
  TOKEN_STALE: 'Shioaji 登入權杖尚未有效，請完全結束程式後重新連線',
  HEALTH_UNHEALTHY: 'Shioaji 已回應，但工作階段健康檢查未通過，請匯出連線診斷',
  STARTUP_TIMEOUT: 'Shioaji 啟動等待逾時，本機健康檢查尚未就緒，請檢查網路後重試',
} as const;
export type NativeFailureCode = keyof typeof issues;
const patterns: [NativeFailureCode, RegExp][] = [
  ['CA_PASSWORD', /ca password incorrect|incorrect (?:ca |certificate )password/i],
  ['CA_EXPIRED', /ca has expired|ca certificate (?:has )?expired/i],
  ['CA_INVALID', /failed to (?:load|activate) (?:ca |the )?certificate|ca activation failed/i],
  ['SIGN_TIME', /sign data is timeout/i],
  ['PUBLIC_IP', /public ip not available/i],
  ['SESSION_BUSY', /no available token slot|daemon already running|http server is already running/i],
  ['SESSION_INVALID', /invalid token format|tokenpoolerror\s*::\s*(?:serialization|encryption|tokenexpired)/i],
  ['PORT_IN_USE', /address already in use|os error (?:98|10048)\b/i],
  ['NETWORK_TLS', /certificate verify failed|invalid peer certificate|unknown issuer|invalidcertificate/i],
  ['NETWORK_DNS', /dns error|failed to lookup address|name or service not known/i],
  ['AUTH_REJECTED', /invalid api[ _-]?key|invalid secret[ _-]?key|api[ _-]?key (?:has )?expired|ip (?:is )?not (?:allowed|in (?:the )?whitelist)|status(?: code)?:?\s*(?:401|403)\b/i],
];
/** Reduce native output to fixed codes. Never expose or save raw output, paths or broker responses. */
export class NativeStartup {
  private buffers = new Map<string,string>();
  code?: NativeFailureCode;
  exitCode: number|null = null;
  signal: string|null = null;
  readonly startedAt = performance.now();
  elapsedMs = 0;
  consume(channel: string, chunk: Uint8Array|string): void {
    // Bounded independently per pipe, including when an error is split between chunks.
    const text = ((this.buffers.get(channel) ?? '') + Buffer.from(chunk).toString('utf8')).slice(-4096);
    this.buffers.set(channel, text);
    for (const [code, pattern] of patterns) if (pattern.test(text)) { this.code ??= code; break; }
  }
  exited(code: number|null, signal: string|null): void {
    this.exitCode = Number.isSafeInteger(code) ? code : null;
    this.signal = signal && ['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGILL','SIGINT'].includes(signal) ? signal : null;
  }
  discard(): void { this.buffers.clear(); this.elapsedMs = Math.round(performance.now() - this.startedAt); }
  ready(): void {this.discard();this.code=undefined;this.exitCode=null;this.signal=null;}
  get caFailure(): boolean { return !!this.code?.startsWith('CA_'); }
  failure(fallback: NativeFailureCode, health?: BrokerHealth): string {
    this.code ??= fallback==='PROCESS_START'||fallback==='PROCESS_EXIT' ? fallback : health?.session_recovering ? 'SESSION_RECOVERING'
      : health?.token_stale || (health?.token_expires_in_seconds !== undefined && health.token_expires_in_seconds <= 0) ? 'TOKEN_STALE'
      : health?.status === 'unhealthy' ? 'HEALTH_UNHEALTHY' : fallback;
    this.discard();
    const exit = this.exitCode !== null ? `；退出碼 ${this.exitCode}` : this.signal ? `；${this.signal}` : '';
    return `${issues[this.code]}（${this.code}${exit}）`;
  }
}
