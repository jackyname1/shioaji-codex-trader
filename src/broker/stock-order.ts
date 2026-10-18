import {z} from 'zod';
import {OrderSchema,d,type Instrument,type Order} from '../core/models.js';
import {alignedPrice} from '../core/risk.js';
import {NoSubmissionError} from './types.js';
import {lotQuantityIssues} from '../core/stock-lot.js';

// TWSE ordinary orders: at most 499 trading units per request. Internal quantities always use shares.
const accountSchema=z.object({account_type:z.literal('S'),broker_id:z.string().min(1),account_id:z.string().min(1),signed:z.literal(true)});
/** Official HTTP stock_order contract, verified 2026-10-19. No credentials or CA bytes in this payload. */
export function stockOrderPayload(raw:Order,instrument:Instrument,selected:unknown){
  const parsed=OrderSchema.safeParse(raw),account=accountSchema.safeParse(selected);
  if(!parsed.success||!account.success)throw new NoSubmissionError('委託格式或證券帳戶尚未確認');
  const o=parsed.data,issues=lotQuantityIssues(o.lot,o.shares);
  if(o.status!=='SUBMITTING'||o.broker_id||o.filled||o.purpose==='EXTERNAL')issues.push('僅可提交尚未送出的本機委託');
  if(instrument.symbol!==o.symbol||instrument.kind!=='STOCK'||!['TSE','OTC'].includes(instrument.exchange))issues.push('委託商品或交易所不符');
  if(!alignedPrice(o.limit_price)||d(o.limit_price).lt(instrument.limit_down)||d(o.limit_price).gt(instrument.limit_up))issues.push('委託價格或跳動單位不符');
  if(issues.length)throw new NoSubmissionError(issues.join('；'));
  return {contract:{security_type:'STK' as const,exchange:instrument.exchange,code:o.symbol},stock_order:{
    action:o.action==='BUY'?'Buy' as const:'Sell' as const,price:Number(o.limit_price),
    quantity:o.lot==='ODD'?o.shares:o.shares/1000,price_type:'LMT' as const,order_type:'ROD' as const,
    order_lot:o.lot==='ODD'?'IntradayOdd' as const:'Common' as const,order_cond:'Cash' as const,
    daytrade_short:false,custom_field:o.tag,account:{broker_id:account.data.broker_id,account_id:account.data.account_id}}};
}
