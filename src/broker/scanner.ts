import { z } from 'zod';
import { d, money } from '../core/models.js';

const amount=z.union([z.number().finite(),z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(money);
const row=z.object({code:z.string(),name:z.string(),close:amount,total_amount:amount});
export type StockScanner='AmountRank'|'VolumeRank'|'ChangePercentRank';
/** Shioaji/Pro use ascending=true for largest first, despite the flag's name. */
export async function largestStockScanner(broker:{request:(path:string,body?:unknown)=>Promise<unknown>},
  scanner_type:StockScanner,date:string,count:number):Promise<z.infer<typeof row>[]> {
  const rows=z.array(row).parse(await broker.request('/data/scanner',{scanner_type,date,ascending:true,count:Math.min(200,count)}));
  const unique=new Map<string,z.infer<typeof row>>();
  for(const item of rows)if(/^[1-9]\d{3}$/.test(item.code)&&d(item.close).gt(0)&&d(item.total_amount).gte(0))unique.set(item.code,item);
  return [...unique.values()].sort((a,b)=>d(b.total_amount).cmp(a.total_amount));
}
