import type {Order} from './models.js';
// Internal quantities use shares; the native Common order quantity uses 1000-share units.
export const COMMON_MAX_SHARES=499000;
export function lotQuantityIssues(lot:Order['lot'],shares:number):string[]{
  if(!Number.isSafeInteger(shares)||shares<=0)return ['委託股數必須為正整數'];
  if(lot==='ODD')return shares>999?['零股委託必須為 1–999 股']:[];
  return shares%1000!==0||shares>COMMON_MAX_SHARES?['整股委託必須為 1000 股倍數且單筆不超過 499 張']:[];
}
