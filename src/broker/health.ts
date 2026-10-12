import { z } from 'zod';
import { NoSubmissionError } from './types.js';

export const BrokerHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']), session_recovering: z.boolean().optional(),
  token_stale: z.boolean().optional(), token_expires_in_seconds: z.number().optional(),
  ca_expired: z.boolean().optional(), ca_expires_in_days: z.number().optional(),
});
export type BrokerHealth = z.infer<typeof BrokerHealthSchema>;
export function marketReady(health: BrokerHealth): boolean {
  return health.status !== 'unhealthy' && !health.session_recovering && !health.token_stale
    && (health.token_expires_in_seconds === undefined || health.token_expires_in_seconds > 0);
}
export class BrokerError extends Error {
  constructor(message: string, readonly retryable = false, readonly status?: number) { super(message); }
}
const stages: Record<string, string> = {
  '/info': '服務', '/health': '登入狀態', '/auth/accounts': '帳戶清單', '/auth/subscribe_trade': '委託回報訂閱',
  '/order/trades': '委託核對', '/order/trade_cache_health': '委託回報', '/portfolio/account_balance': '交割戶餘額',
  '/portfolio/settlements': '交割款', '/portfolio/position_unit': '庫存', '/portfolio/position_detail': '庫存明細',
  '/stream/subscribe': '行情訂閱', '/stream/unsubscribe': '行情退訂', '/stream/data':'行情串流', '/data/kbars': '歷史 K 線', '/data/scanner': '歷史排行',
};
export const requestStage = (path: string): string => stages[path.split('?')[0]!] ?? (path.startsWith('/data/') ? '行情資料' : '本機服務');
export function brokerIssue(error: unknown): string {
  if (error instanceof BrokerError || error instanceof NoSubmissionError) return error.message;
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.flatMap(i => i.path.filter(p => typeof p === 'string')))];
    return 'Shioaji 回應格式無法核對' + (fields.length ? '（' + fields.slice(0, 4).join('、') + '）' : '');
  }
  const kind=error instanceof Error&&['TypeError','SyntaxError','RangeError','TimeoutError','AbortError'].includes(error.name)?`（${error.name}）`:'';
  return `Shioaji 本機資料處理未完成${kind}；請查看連線診斷，正在重新核對`;
}
export function brokerStageIssue(stage: string, error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  return new BrokerError(error instanceof z.ZodError?`Shioaji ${stage}未完成核對：${brokerIssue(error).replace(/^Shioaji /,'')}`:
    `Shioaji ${stage}未完成核對，稍後自動重試`,true);
}
