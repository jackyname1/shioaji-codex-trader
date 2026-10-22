import type {BacktestReport} from './backtest.js';
export function backtestSeries(r:BacktestReport){
 const equity=r.timeline?.length?r.timeline:r.daily_equity.map(e=>({at:e.asof,equity:e.equity,cash:e.cash,exposure_pct:e.exposure_pct}));
 // Display-only arithmetic. Accounting remains Decimal in the engine and audit.
 let peak=Number(r.request.initial_cash),costs=0;
 const drawdown=equity.map(e=>{peak=Math.max(peak,Number(e.equity));return {at:e.at,equity:peak>0?((Number(e.equity)-peak)/peak*100).toFixed(4):'0'};});
 const fees=r.fills.map(f=>{costs+=Number(f.fee)+Number(f.tax);return {at:f.at,equity:String(costs)};});
 const exposure=equity.filter(e=>e.exposure_pct!==undefined).map(e=>({at:e.at,equity:e.exposure_pct!}));
 return {drawdown,costs:fees,exposure:exposure.length?exposure:r.daily_equity.filter(e=>e.exposure_pct!==undefined).map(e=>({at:e.asof,equity:e.exposure_pct!}))};
}
