import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {programAnalysis as current} from '../dist/src/core/program-strategy.js';
import {runBacktest} from '../dist/src/core/backtest.js';
import {SettingsSchema,d,twDay} from '../dist/src/core/models.js';
import {marketRegime} from '../dist/src/core/portfolio-risk.js';
const [dataPath,baselinePath,output='validation/v025/comparison.json']=process.argv.slice(2);
if(!dataPath||!baselinePath)throw Error('node scripts/compare-v025.mjs DATA.json.gz BASELINE_V024_DIR OUTPUT.json');
const protocol=JSON.parse(readFileSync('validation/v025/protocol.json'));
const source=readFileSync(resolve(baselinePath,'src/core/program-strategy.ts'));
const originalHash=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${source.length}\0`),source])).digest('hex');
if(originalHash!=='496784bac45faf15065eb3869b4ddb6b671d8df0')throw Error('Baseline source does not match v0.2.4');
const raw=readFileSync(dataPath),bytes=raw[0]===31?gunzipSync(raw):raw,data=JSON.parse(bytes);
if(!data.daily_universe)throw Error('Comparison requires dated dynamic historical universe');
const {programAnalysis:original}=await import(pathToFileURL(resolve(baselinePath,'dist/src/core/program-strategy.js')).href);
const common={mode:'paper',auto_execute:false,min_cash_fraction:'0.25',order_budget_basis:'AFTER_RESERVE',max_order_fraction:'0.10',
 max_symbol_fraction:'0.20',max_exposure_fraction:'0.75',max_daily_buy_fraction:'0.20',max_daily_buy_orders:5,daily_loss_fraction:'0.02',
 target_exposure_fraction:'0.50',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.01',watch_max_symbols:16,
 fee_rate:'0.001425',minimum_fee:'20',sell_tax_rate:'0.003',risk_slippage_fraction:'0.001',experience_enabled:false};
const variants=[['A_original_rules',{}]];
for(const dd of ['0.03','0.04','0.05'])for(const cool of [1,2,3])variants.push([`B_dd${dd.slice(2)}_cool${cool}`,{portfolio_risk_enabled:true,portfolio_drawdown_fraction:dd,portfolio_cooldown_sessions:cool}]);
variants.push(['C_entry_quality',{entry_quality_enabled:true}],['C_atr_entries',{entry_quality_enabled:true,entry_strategy_mode:'multi',dynamic_allocation:true}],['D_fixed',{research_exit_mode:'fixed'}],['D_atr_trail',{research_exit_mode:'atr_trail'}],
 ['E_research_combined',{portfolio_risk_enabled:true,portfolio_drawdown_fraction:'0.04',portfolio_cooldown_sessions:2,entry_quality_enabled:true,research_exit_mode:'atr_trail'}]);
const cases=[];
for(const [fold,period] of protocol.walk_forward.entries())for(const [name,overrides] of variants)cases.push({fold:fold+1,...period,name,overrides,participation:'0.01'});
// Exploratory mechanism ablations added after bundle diagnostics; never used for parameter selection.
for(const [fold,period] of protocol.walk_forward.entries())for(const component of ['drawdown','regime','loss_streak'])
 cases.push({fold:fold+1,...period,name:'B_only_'+component,exploratory_ablation:true,overrides:{portfolio_risk_enabled:true,portfolio_components:component},participation:'0.01'});
// Stress is predeclared, applied to A and the combined research hypothesis, never optimized.
for(const name of ['A_original_rules','E_research_combined'])for(const [label,overrides,participation] of [
 ['low_liquidity',{},'0.001'],['slip30bps',{risk_slippage_fraction:'0.003'},'0.01'],['slip50bps',{risk_slippage_fraction:'0.005'},'0.01']])
 cases.push({fold:2,...protocol.walk_forward[1],name:name+'_'+label,overrides:{...variants.find(v=>v[0]===name)[1],...overrides},participation});
mkdirSync(resolve(output,'..'),{recursive:true});mkdirSync(resolve(output,'..','run-audits'),{recursive:true});
const modulePaths=['src/core/engine.js','src/core/calendar.js','src/core/risk.js','src/core/costs.js','src/core/capital.js','src/core/portfolio-risk.js','src/core/entry-quality.js','src/core/program-strategy.js','src/core/watchlist.js','src/core/smart.js','src/core/backtest-data.js','src/broker/paper.js'];
const engine_sha256=createHash('sha256').update(modulePaths.map(p=>readFileSync(resolve('dist',p))).join('\n')).digest('hex');
const metadata={engine_sha256,protocol,protocol_sha256:createHash('sha256').update(readFileSync('validation/v025/protocol.json')).digest('hex'),
 dataset_sha256:createHash('sha256').update(bytes).digest('hex'),dataset_source:data.source,common,baseline_commit:'787a7af454143b2f3f49a7cbdb2c6b658189fd96',
 baseline_program_sha256:createHash('sha256').update(source).digest('hex'),expected_cases:cases.length};
const selected=process.env.TRADER_COMPARE_CASE;
if(selected===undefined){
 let next=0;const results=[];
 await Promise.all(Array.from({length:4},async()=>{for(;;){const index=next++;if(index>=cases.length)return;
  const file=output+`.case${index}.json`;
  if(!existsSync(file)||JSON.parse(readFileSync(file)).engine_sha256!==engine_sha256||JSON.parse(readFileSync(file)).dataset_sha256!==metadata.dataset_sha256||JSON.parse(readFileSync(file)).protocol_sha256!==metadata.protocol_sha256)await new Promise((done,fail)=>{const child=spawn(process.execPath,[process.argv[1],dataPath,baselinePath,file],{stdio:'inherit',env:{...process.env,TRADER_COMPARE_CASE:String(index)}});
   child.once('error',fail);child.once('exit',code=>code===0?done():fail(Error(`case ${index} failed (${code})`)));});
  results.push(JSON.parse(readFileSync(file)).result);results.sort((a,b)=>a.case_index-b.case_index);
  writeFileSync(output,JSON.stringify({...metadata,status:results.length===cases.length?'COMPLETED':'PARTIAL',completed_cases:results.length,results},null,2)+'\n');
 }}));process.exit(0);
}
const index=Number(selected),c=cases[index];if(!c)throw Error('Invalid case');
// Storage union is never the decision universe; the dated membership remains authoritative.
const union=new Set(Object.entries(data.daily_universe).filter(([day])=>day>=c.test_start&&day<=c.test_end).flatMap(([,u])=>u.symbols));
const startMs=Date.parse(c.test_start)-160*86400000,end=c.test_end+'T23:59:59Z';
const dataset={...data,points:data.points.filter(p=>union.has(p.symbol)&&Date.parse(p.at)>=startMs&&p.at<=end)};
const settings=SettingsSchema.parse({...common,...c.overrides}),regimes={};
const policy=(snap,s)=>{if(!snap.review_only)regimes[twDay(new Date(snap.asof))]=marketRegime(snap.features,new Date(snap.asof)).regime;return s.entry_quality_enabled?current(snap,s):original(snap,s);};
const report=await runBacktest({start:c.test_start,end:c.test_end,source:'csv',strategy:'rules',capital_profile:'custom',initial_cash:'100000',
 entry_cadence:'market',strategy_schedule:'interval',decision_interval_minutes:180,monitor_interval_seconds:300,watch_refresh_minutes:5,participation:c.participation,execution_slippage_bps:c.name.includes('slip30')?30:c.name.includes('slip50')?50:10},
 dataset,settings,undefined,new AbortController().signal,p=>{if(p.phase==='ANALYSIS'&&p.day.endsWith('-01'))console.log(JSON.stringify({case:index,progress:p.day}));},undefined,undefined,undefined,undefined,policy);
const byRegime={},episodes=new Map(),closed=[];
for(const f of report.fills){
 let p=episodes.get(f.symbol)??{symbol:f.symbol,entry_at:f.at,shares:0,pnl:d(0),costs:d(0),regime:regimes[twDay(new Date(f.at))]??'UNKNOWN',signal:report.orders.find(o=>o.local_id===f.order_id)?.trigger_reason?.match(/BREAKOUT20|PULLBACK20|TREND/)?.[0]??'EXPLICIT'};
 p.costs=p.costs.plus(f.fee).plus(f.tax);
 if(f.action==='BUY')p.shares+=f.shares;
 else {p.shares-=f.shares;p.pnl=p.pnl.plus(f.realized_pnl??0);if(!p.shares){const row={...p,pnl:p.pnl.toFixed(),costs:p.costs.toFixed(),exit_at:f.at};closed.push(row);episodes.delete(f.symbol);
 const b=byRegime[p.regime]??={trades:0,pnl:'0',wins:0,costs:'0'};b.trades++;b.pnl=d(b.pnl).plus(p.pnl).toFixed();b.costs=d(b.costs).plus(p.costs).toFixed();if(p.pnl.gt(0))b.wins++;continue;}}
 episodes.set(f.symbol,p);
}
const terminalCosts=report.positions.reduce((v,p)=>{const amount=d(p.last_price).times(p.shares);return v.plus(d(settings.minimum_fee).gt(amount.times(settings.fee_rate).ceil())?settings.minimum_fee:amount.times(settings.fee_rate).ceil()).plus(amount.times(settings.sell_tax_rate).ceil());},d(0));
const simultaneous_gap_stress={};for(const gap of ['0.05','0.10'])simultaneous_gap_stress[gap]=report.positions.reduce((v,p)=>v.plus(d(p.last_price).times(p.shares).times(gap)),d(0)).plus(terminalCosts).toFixed();
const result={case_index:index,...c,status:report.status,metrics:{...report.metrics,expectancy:closed.length?closed.reduce((v,t)=>v.plus(t.pnl),d(0)).div(closed.length).toFixed():null,
 terminal_liquidation_net_equity:d(report.metrics.final_equity).minus(terminalCosts).toFixed()},by_regime:byRegime,closed_episodes:closed,
 simultaneous_gap_stress,quality:report.quality,limitations:report.limitations,diagnostics:report.entry_diagnostics};
const name=`fold${c.fold}-${c.name}.json.gz`,archive=gzipSync(Buffer.from(JSON.stringify(report)));writeFileSync(resolve(output,'..','run-audits',name),archive);
result.execution_audit={file:name,sha256:createHash('sha256').update(archive).digest('hex')};
writeFileSync(output,JSON.stringify({...metadata,result},null,2)+'\n');
console.log(JSON.stringify({case:index,fold:c.fold,name:c.name,status:report.status,net:report.metrics.return_pct,dd:report.metrics.max_drawdown_pct,trades:closed.length}));
