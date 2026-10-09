import { z } from 'zod';
import { d, type Settings } from './models.js';
import type { Store } from './store.js';

const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(v => d(v).isFinite());
export const ExperienceSchema = z.strictObject({
  id: z.string().min(1), at: z.string().datetime({offset:true}), mode: z.string().min(1),
  kind: z.enum(['SIMULATED_FILL','RECONCILED_FILL','RISK_REFUSAL','ANALYSIS_FAILURE']),
  symbol: z.string(), action: z.enum(['BUY','SELL','NONE']), shares: z.number().int().nonnegative(),
  price: amount.nullable(), fee: amount.nullable(), tax: amount.nullable(),
  realized_pnl: amount.nullable(), note: z.string().max(3000),
});
export type Experience = z.infer<typeof ExperienceSchema>;
export const ReviewSchema = z.strictObject({
  id: z.string().min(1), at: z.string().datetime({offset:true}), mode: z.string().min(1),
  summary: z.string().min(1).max(3000), sample_count: z.number().int().nonnegative(),
});
export type ExperienceReview = z.infer<typeof ReviewSchema>;
export interface ExperienceContext {
  scope: string; asof: string; sample_count: number; realized_pnl: string | null;
  observations: Omit<Experience,'id'|'mode'>[]; reviews: Omit<ExperienceReview,'id'|'mode'>[];
  limitations: string[];
}
export function experienceContext(store: Store, settings: Settings, asof: string): ExperienceContext {
  const scope = store.get<string>('experience_scope') ?? settings.mode;
  const observations = settings.experience_enabled ? store.experiences(scope,asof,settings.experience_limit) : [];
  const knownPnl = observations.filter(x => x.realized_pnl !== null);
  return {scope,asof,sample_count:observations.length,
    realized_pnl:knownPnl.length ? knownPnl.reduce((sum,x) => sum.plus(x.realized_pnl!),d(0)).toFixed() : null,
    observations:observations.map(({id:_id,mode:_mode,...x}) => x),
    reviews:settings.experience_enabled ? store.reviews(scope,asof,5).map(({id:_id,mode:_mode,...x}) => x) : [],
    limitations:['這是截至本次快照的有限樣本記錄，不是模型權重訓練，也不能證明策略改善',
      '實盤回報僅核對成交股數，未取得實際成交價格與券商費用時，不推算實盤損益',
      '檢討文字僅供分析參考，不得修改程式、放寬風控或繞過交易限制']};
}
export function experienceStatus(store: Store, settings: Settings, asof: string): string {
  const c = experienceContext(store,settings,asof);
  return [`經驗回饋=${settings.experience_enabled} 範圍=${c.scope} 最近樣本=${c.sample_count}`,
    `可核對的已實現損益（最近樣本）=${c.realized_pnl ?? '無可靠成交成本，未計算'}`,
    ...c.reviews.map(x => `${x.at} 檢討：${x.summary}`),...c.limitations].join('\n');
}
