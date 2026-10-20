import test from 'node:test';
import assert from 'node:assert/strict';
import {strategyItems,strategyDirection,traySnapshot,panelBounds} from '../src/desktop/dashboard.js';
import {SettingsSchema,type Decision} from '../src/core/models.js';
import type {DesktopState,RuntimeView} from '../src/desktop/shared.js';
const now=new Date().toISOString();
const decision:Decision={symbol:'2330',action:'BUY',shares:20,limit_price:'100',entry_when:'REBOUND',trigger_price:'98',rebound_fraction:'0.02',
  smart:{stop_price:'90',take_profit:null,reward_target:'115',trailing_activate:'105',trailing_fraction:'0.03'},reason:'趨勢與成交量合格',
  conditions:[{left:'MA5',operator:'GT',right:'MA20',value:null}]};
function fixture():DesktopState {
  const r={mode:'paper',connected:true,auto:false,paused:false,killed:false,blocked:false,session:true,
    account:{asof:now,cash:'10000',settlement_debits:'1000',settlement_credits:'500',positions:[],orders:[],complete:true},
    plan:{id:'plan',created_at:now,analysis:{expires_at:new Date(Date.parse(now)+3600000).toISOString(),decisions:[decision],summary:'條件買進',stance:'BUY_ALLOWED'}},
    protections:[],orders:[],quotes:[],watch:{entries:[],changes:[]},metadata:{},decisions:[],next_strategy_at:null,last_monitor_at:now} as unknown as RuntimeView;
  return {workspace_mode:'paper',simulation_scope:'realtime',runtime:r,settings:JSON.stringify(SettingsSchema.parse({})),error:'',
    connection:{status:'已連線'},codex_auth:{message:'Codex 已登入'},live:{issues:[]},backtest_progress:{running:false},backtest_running:false} as unknown as DesktopState;
}
test('strategy cards distinguish reference sizing, rebound/AND conditions, execution gates and expiry',()=>{
  const state=fixture(),r=state.runtime!,card=strategyItems(r,now)[0]!;
  assert.match(card.trigger,/跌至 98.*回升 2%.*MA5 > MA20/);assert.match(card.size,/參考 20 股.*另核股數/);
  assert.match(card.protection,/停損 90.*無固定停利.*105/);assert.doesNotMatch(card.protection,/115/);assert.equal(card.state,'等待啟動');
  r.decisions=[{symbol:'2330',state:'WAIT',reason:'等待報價',source:'CODEX'}];
  r.auto=true;r.paused=true;assert.equal(strategyItems(r,now)[0]!.state,'暫停新增買進');
  r.plan!.analysis.expires_at=now;assert.match(strategyItems(r,now)[0]!.state,/到期/);
  r.plan!.created_at='2099-01-01T00:00:00Z';assert.match(strategyItems(r,now)[0]!.state,/尚未生效/);
});
test('HOLD cards never describe a new executable order',()=>{
  const r=fixture().runtime!;r.plan!.analysis.decisions=[{...decision,action:'HOLD',shares:0,limit_price:'0',smart:null}];
  const card=strategyItems(r,now)[0]!;assert.equal(card.price,'—');assert.equal(card.size,'無新委託');assert.match(card.trigger,/不建立新委託/);
});
test('tray cash reserves pending buys and hides stale or partially confirmed balances',()=>{
  const state=fixture(),a=state.runtime!.account!;
  a.orders=[{action:'BUY',status:'PENDING',limit_price:'100',shares:10,filled:0}] as typeof a.orders;
  let view=traySnapshot(state);assert.equal(view.cash,'7,980');assert.equal(view.equity,'9,500');
  a.available={cash:true,positions:true,orders:false,settlements:true};view=traySnapshot(state);assert.equal(view.cash,'—');assert.equal(view.equity,'—');
  delete a.available;a.asof='2020-01-01T00:00:00Z';assert.equal(traySnapshot(state).cash,'—');assert.match(traySnapshot(state).issue,/過期/);
});
test('tray includes broker-account external orders, excludes terminal states and falls back to known local pending orders',()=>{
  const state=fixture(),r=state.runtime!,a=r.account!;
  const order={symbol:'2330',action:'BUY',status:'PENDING',limit_price:'100',shares:10,filled:0,purpose:'EXTERNAL'} as typeof a.orders[number];
  a.orders=[order,{...order,status:'FILLED',filled:10}];
  assert.equal(traySnapshot(state).orders,1);assert.equal(traySnapshot(state).pending[0]!.symbol,'2330');
  a.available={cash:true,positions:true,settlements:true,orders:false};r.orders=[{...order,symbol:'2454'}];
  assert.equal(traySnapshot(state).pending[0]!.symbol,'2454');
});
test('tray projection omits main credentials, account identifiers, logs and grants',()=>{
  const state=fixture();state.settings=JSON.stringify({...SettingsSchema.parse({}),api_key:'SECRET_KEY'});state.logs=['SECRET_LOG'];state.live.account='PRIVATE_ACCOUNT';
  const result=JSON.stringify(traySnapshot(state));assert.doesNotMatch(result,/SECRET_KEY|SECRET_LOG|PRIVATE_ACCOUNT|auto_execute|authorized/);
});
test('tray uses historical scope and historical expiry instead of present-day runtime data',()=>{
  const state=fixture();state.simulation_scope='replay';state.replay={at:now,plan:null,quotes:[],watch:{entries:[],changes:[]},account:{...state.runtime!.account!,cash:'1234',settlement_debits:'0',settlement_credits:'0'}} as unknown as DesktopState['replay'];
  const view=traySnapshot(state);assert.equal(view.cash,'1,234');assert.deepEqual(view.strategies,[]);assert.match(view.workspace,/歷史回放/);assert.doesNotMatch(view.strategy,/條件買進/);
});
test('tray placement stays inside small and offset monitor work areas for every taskbar edge',()=>{
  for(const area of [{x:-1920,y:-100,width:1920,height:1080},{x:0,y:0,width:320,height:500}]){
    for(const point of [{x:area.x,y:area.y},{x:area.x+area.width,y:area.y+area.height}]){
      const box=panelBounds({...point,width:20,height:20},area);assert.ok(box.x>=area.x&&box.y>=area.y);assert.ok(box.x+box.width<=area.x+area.width&&box.y+box.height<=area.y+area.height);
    }
  }
});

test('direction explains explicit reduction, no immediate sale, expired plans and the persisted override',()=>{
  const r=fixture().runtime!,s=SettingsSchema.parse({});
  r.plan!.analysis.stance='REDUCE';r.plan!.analysis.decisions=[{...decision,action:'HOLD',smart:null,shares:0,entry_when:'IMMEDIATE',rebound_fraction:null}];
  let view=strategyDirection(r,s,now);assert.match(view.label,/減碼優先/);assert.match(view.detail,/沒有明確減碼賣單/);
  assert.match(view.detail,/不會立即賣出或清倉/);assert.equal(view.restricted,true);
  r.plan!.analysis.decisions=[{...decision,action:'SELL',shares:7,entry_when:'IMMEDIATE',rebound_fraction:null}];
  view=strategyDirection(r,s,now);assert.match(view.detail,/1 檔/);
  view=strategyDirection(r,{trade_direction:'reduce_only'},now);assert.match(view.label,/僅減碼/);assert.match(view.detail,/待撤單確認前仍可能成交/);
  r.plan!.analysis.stance='BUY_ALLOWED';r.plan!.analysis.decisions=[decision];
  assert.equal(strategyItems(r,now,'reduce_only')[0]!.state,'方向禁止新買進');
  r.plan!.analysis.expires_at=now;assert.match(strategyDirection(r,s,now).label,/已到期/);
});
