import { z } from 'zod';
import { d, money } from '../core/models.js';
import { HistoryPointSchema, type HistoryPoint } from '../core/backtest-data.js';
const numeric=z.union([z.number().finite(),z.string().regex(/^-?\d+(?:\.\d+)?$/)]).transform(money);
export function historicalKbars(raw:unknown,symbol:string):HistoryPoint[] {
  const r=z.object({datetime:z.array(z.string()).optional(),ts:z.array(z.union([z.number().finite(),z.string().regex(/^\d+$/)])).optional(),
    Open:z.array(numeric).optional(),High:z.array(numeric),Low:z.array(numeric),Close:z.array(numeric),
    Volume:z.array(z.number().int().nonnegative()),Amount:z.array(numeric).optional()}).parse(raw);
  const stamps=r.datetime??r.ts;
  if(!stamps||[r.Open??r.Close,r.High,r.Low,r.Close,r.Volume,...(r.Amount?[r.Amount]:[])].some(a=>a.length!==stamps.length))throw new Error('歷史 K 線欄位長度不符');
  return stamps.flatMap((stamp,i)=>{
    let date:Date;
    if(r.datetime) {const value=String(stamp).replace(' ','T');date=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?value:value+'+08:00');}
    else date=new Date(d(stamp).div(1000000).floor().toNumber());
    if(Number.isNaN(date.getTime()))throw new Error('歷史 K 線時間不合法');
    if(!d(r.Close[i]!).gt(0))return [];
    return [HistoryPointSchema.parse({symbol,at:date.toISOString(),open:r.Open?.[i]??r.Close[i],high:r.High[i],low:r.Low[i],close:r.Close[i],
      volume_shares:r.Volume[i]!*1000,...(r.Amount?{amount_twd:r.Amount[i]}:{})})]; // Volume is lots; Amount is already TWD.
  });
}
