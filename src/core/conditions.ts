import {d,twDay,twClock,type Condition,type Decision,type Features,type Quote} from './models.js';

const featureFields={MA5:'ma5',MA20:'ma20',MA60:'ma60',RSI14:'rsi14',ATR14:'atr14',SUPPORT20:'support20',
  RESISTANCE20:'resistance20',VOLUME_RATIO20:'volume_ratio20',RETURN20:'return20'} as const;
export function conditionIssue(decision:Decision,quote:Quote,features:Features|undefined,now:Date):string {
  const operand=(field:Condition['left']):string|undefined=>{
    if(field==='LAST')return quote.last;if(field==='BID')return d(quote.bid).gt(0)?quote.bid:undefined;
    if(field==='ASK')return d(quote.ask).gt(0)?quote.ask:undefined;
    // An absent, future, or incomplete daily indicator never satisfies a guard.
    if(!features?.sufficient||!features.asof||features.asof>twDay(now)
      ||features.asof===twDay(now)&&twClock(now)<'13:40')return;
    const value=features[featureFields[field]];return typeof value==='number'&&Number.isFinite(value)?String(value):undefined;
  };
  for(const c of decision.conditions??[]){
    const left=operand(c.left),right=c.right==='VALUE'?c.value:operand(c.right);
    if(left===undefined||right===undefined||right===null)return `條件資料未就緒：${c.left} ${c.operator} ${c.right}`;
    const comparison=d(left).cmp(right),passed=c.operator==='GT'?comparison>0:c.operator==='GTE'?comparison>=0:c.operator==='LT'?comparison<0:comparison<=0;
    if(!passed)return `條件未成立：${c.left} ${c.operator} ${c.right==='VALUE'?c.value:c.right}（${left}／${right}）`;
  }
  return '';
}
