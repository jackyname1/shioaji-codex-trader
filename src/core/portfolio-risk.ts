import {Decimal} from 'decimal.js';
import {d,equity,twDay,ageSeconds,type Account,type Features,type Settings} from './models.js';
import type {Experience} from './experience.js';
export type Regime='TREND'|'RANGE'|'HIGH_RISK'|'UNKNOWN';
export interface PortfolioState {version:1;high_water:string;equity:string;asof:string;session_day:string;session_index:number;
  blocked_until_session?:number;drawdown_latched?:boolean;loss_latched?:boolean;last_loss_event?:string}
export interface PortfolioDecision {state:PortfolioState;drawdown_fraction:string;regime:Regime;scale:string;
  blocked:boolean;reasons:string[];breadth:number|null;median_atr_fraction:number|null;closed_trades:number;recent_expectancy:string|null;
  provenance:string}
/** As-of breadth proxy of the dynamic pool, NOT a TAIEX/index regime or a historical full-market universe. */
export function marketRegime(features:Record<string,Features>,now:Date){
  const usable=Object.values(features).filter(f=>f.sufficient&&f.asof&&f.asof<twDay(now)
    &&Date.parse(twDay(now))-Date.parse(f.asof)<=7*86400000
    &&[f.ma5,f.ma20,f.ma60,f.atr14,f.last_close].every(v=>v!==undefined&&Number.isFinite(v)&&v>0));
  if(usable.length<5)return {regime:'UNKNOWN' as Regime,breadth:null,median_atr_fraction:null};
  const breadth=usable.filter(f=>f.last_close!>=f.ma20!&&f.ma20!>=f.ma60!).length/usable.length;
  const vol=usable.map(f=>f.atr14!/f.last_close!).sort((a,b)=>a-b),median=vol[Math.floor(vol.length/2)]!;
  const regime:Regime=breadth<.35||median>.065?'HIGH_RISK':breadth>=.6&&median<=.045?'TREND':'RANGE';
  return {regime,breadth,median_atr_fraction:median};
}
/** Only complete flat-to-flat episodes; partial executions never inflate a loss streak. */
export function closedEpisodes(events:Experience[],asof:string){
  const inventory=new Map<string,{shares:number;pnl:Decimal;valid:boolean}>(),closed:{id:string;at:string;pnl:string}[]=[];
  for(const e of events.filter(e=>e.kind==='SIMULATED_FILL'&&Date.parse(e.at)<=Date.parse(asof)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){
    const p=inventory.get(e.symbol)??{shares:0,pnl:d(0),valid:true};
    if(e.action==='BUY')p.shares+=e.shares;
    if(e.action==='SELL'){
      p.shares-=e.shares;if(e.realized_pnl===null||p.shares<0)p.valid=false;
      p.pnl=p.pnl.plus(e.realized_pnl??0);
      if(p.shares===0){if(p.valid)closed.push({id:e.id,at:e.at,pnl:p.pnl.toFixed()});p.pnl=d(0);p.valid=true;}
    }
    inventory.set(e.symbol,p);
  }
  return closed;
}
export function portfolioDecision(previous:PortfolioState|undefined,a:Account,features:Record<string,Features>,
  events:Experience[],s:Settings,now:Date,isSession:boolean):PortfolioDecision {
  const e=equity(a),at=now.toISOString(),valid=a.complete&&e.gt(0)&&ageSeconds(now,a.asof)>=0&&ageSeconds(now,a.asof)<=s.account_max_age;
  // Incomplete, future or out-of-order input must not mutate the persisted high-water mark.
  const chronological=!previous||Date.parse(at)>=Date.parse(previous.asof);
  const day=twDay(now),state:PortfolioState=previous?structuredClone(previous):
    {version:1,high_water:valid?e.toFixed():'0',equity:valid?e.toFixed():'0',asof:at,session_day:day,session_index:0};
  if(valid&&chronological){
    if(isSession&&state.session_day!==day){state.session_index++;state.session_day=day;}
    state.high_water=Decimal.max(state.high_water,e).toFixed();state.equity=e.toFixed();state.asof=at;
  }
  const dd=d(state.high_water).gt(0)?Decimal.max(0,d(1).minus(e.div(state.high_water))):d(0);
  const regime=marketRegime(features,now),closed=closedEpisodes(events,at),recent=closed.slice(-5);
  const expectancy=recent.length?recent.reduce((v,t)=>v.plus(t.pnl),d(0)).div(recent.length):null;
  let streak=0;for(const t of [...closed].reverse()){if(d(t.pnl).gte(0))break;streak++;}
  const reasons:string[]=[];let scale=d(1);
  const useDD=s.portfolio_components==='all'||s.portfolio_components==='drawdown',useRegime=s.portfolio_components==='all'||s.portfolio_components==='regime',useLoss=s.portfolio_components==='all'||s.portfolio_components==='loss_streak';
  if(s.portfolio_risk_enabled){
    if(!valid||!chronological)reasons.push('組合資產快照無效或時間倒退');
    if(valid&&chronological){
      if(useDD&&dd.gte(s.portfolio_drawdown_fraction)&&!state.drawdown_latched){state.drawdown_latched=true;
        state.blocked_until_session=state.session_index+s.portfolio_cooldown_sessions;}
      const last=closed.at(-1)?.id;
      if(useLoss&&streak>=s.portfolio_loss_streak&&last&&last!==state.last_loss_event){state.loss_latched=true;state.last_loss_event=last;
        state.blocked_until_session=Math.max(state.blocked_until_session??0,state.session_index+s.portfolio_cooldown_sessions);}
      const cooled=state.session_index>=(state.blocked_until_session??0);
      if(cooled&&dd.lt(d(s.portfolio_drawdown_fraction).div(2)))state.drawdown_latched=false;
      if(cooled&&(!useRegime||regime.regime==='TREND'))state.loss_latched=false;
    }
    if(useDD&&state.drawdown_latched)reasons.push('組合高點回撤封鎖新增風險；等待冷卻及回撤恢復');
    if(useLoss&&state.loss_latched)reasons.push('連續虧損冷卻；等待交易日及趨勢恢復');
    if(useRegime&&regime.regime==='UNKNOWN')reasons.push('市場廣度代理資料不足，保留現金');
    if(useDD&&dd.gte(d(s.portfolio_drawdown_fraction).div(2)))scale=Decimal.min(scale,'.5');
    if(useRegime&&regime.regime==='HIGH_RISK')scale=Decimal.min(scale,'.25');
    if(useRegime&&regime.regime==='RANGE')scale=Decimal.min(scale,'.5');
    if(useLoss&&recent.length>=3&&expectancy?.lt(0))scale=Decimal.min(scale,'.5');
  }
  if(reasons.length)scale=d(0);
  return {state,drawdown_fraction:dd.toFixed(),...regime,scale:scale.toFixed(),blocked:scale.eq(0),reasons,
    closed_trades:closed.length,recent_expectancy:expectancy?.toFixed()??null,
    provenance:'Observed account equity; prior completed dynamic-pool daily features. No index/real odd-lot depth inference.'};
}
