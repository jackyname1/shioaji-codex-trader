import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {assumedQuote} from '../dist/src/core/fill-assumptions.js';
import {tradeStatistics} from '../dist/src/core/performance.js';
import {indicators} from '../dist/src/core/strategy.js';
import {breadthState} from '../dist/src/core/entry-policy.js';
import {roundPrice,tickSize} from '../dist/src/core/risk.js';
const [baselineDir,output='validation/v030/comparison.json']=process.argv.slice(2);
if(!baselineDir)throw Error('Build both checkouts, then: node scripts/compare-v030.mjs BASELINE_V029_DIRECTORY [OUTPUT.json]');
const protocolBytes=readFileSync('validation/v030/protocol.json'),protocol=JSON.parse(protocolBytes);
if(execFileSync('git',['rev-parse','HEAD'],{cwd:baselineDir,encoding:'utf8'}).trim()!==protocol.baseline_commit)throw Error('Wrong baseline commit');
const raw=readFileSync(protocol.dataset),data=JSON.parse(gunzipSync(raw)),sha=b=>createHash('sha256').update(b).digest('hex');
const cases=protocol.periods.flatMap(period=>protocol.fill_assumptions.flatMap(fill=>protocol.policies.map(policy=>({period,fill,policy}))));
const engineHash=dir=>sha(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','src/core','src/broker'],{cwd:dir,encoding:'utf8'}).trim().split('\n').sort().map(p=>p+'\0'+readFileSync(resolve(dir,p),'utf8')).join('\n'));
const metadata={protocol,protocol_sha256:sha(protocolBytes),dataset_sha256:sha(raw),baseline_engine_sha256:engineHash(baselineDir),current_engine_sha256:engineHash(process.cwd()),limitations:protocol.rules};
mkdirSync(dirname(resolve(output)),{recursive:true});
const caseIndex=process.env.TRADER_V030_CASE;
function benchmarks(period,fill){
  const marks=new Map(),holdings=new Map();let cash=100000,fees=0,peak=100000,mdd=0;
  const points=data.points.filter(p=>p.at.slice(0,10)>=period.start&&p.at.slice(0,10)<=period.end);
  for(const day of [...new Set(points.map(p=>p.at.slice(0,10)))].sort()){
    for(const p of points.filter(p=>p.at.slice(0,10)===day)){
      if(!holdings.has(p.symbol)){
        const q=assumedQuote({last:p.open,bid:roundPrice(Number(p.open)-Number(tickSize(p.open))),ask:roundPrice(Number(p.open)+Number(tickSize(p.open)),false),bid_shares:1000000,ask_shares:1000000,book_source:'APPROXIMATE'},fill,false);
        const shares=q.ask_shares?Math.floor(7500/Number(q.ask)):0,amount=shares*Number(q.ask),cost=shares?Math.max(20,Math.ceil(amount*.001425)):0;
        holdings.set(p.symbol,shares);cash-=amount+cost;fees+=cost;
      }
      marks.set(p.symbol,Number(p.close));
    }
    const eq=cash+[...holdings].reduce((n,[s,shares])=>n+shares*(marks.get(s)??0),0);peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak*100);
  }
  const equity=cash+[...holdings].reduce((n,[s,shares])=>n+shares*(marks.get(s)??0),0);
  return {period,fill,cash:{return_pct:0,max_drawdown_pct:0},equal_weight_75pct:{return_pct:(equity/100000-1)*100,max_drawdown_pct:mdd,fees,terminal_equity:equity,terminal_cash:cash,liquidated:false}};
}
if(caseIndex===undefined){
  const results=[];
  let next=0;
  await Promise.all(Array.from({length:3},async()=>{for(;;){const index=next++;if(index>=cases.length)return;
    const file=resolve(dirname(output),`case-${index}.json`);
    await new Promise((done,fail)=>{const child=spawn(process.execPath,[process.argv[1],baselineDir,file],{stdio:'inherit',env:{...process.env,TRADER_V030_CASE:String(index)},timeout:180000});
      child.once('error',fail);child.once('exit',code=>code===0?done():fail(Error(`Case ${index} failed`)));});
    results.push(JSON.parse(readFileSync(file)).result);
  }}));
  results.sort((a,b)=>a.case_index-b.case_index);
  const benchmarkResults=protocol.periods.flatMap(p=>protocol.fill_assumptions.map(f=>benchmarks(p,f)));
  writeFileSync(output,JSON.stringify({...metadata,benchmarks:benchmarkResults,results},null,2)+'\n');process.exit(0);
}
const index=Number(caseIndex),c=cases[index],root=c.policy==='v029_legacy'?baselineDir:process.cwd();
const load=p=>import(pathToFileURL(resolve(root,'dist/src/core',p+'.js')).href);
const [{runBacktest},{SettingsSchema},{HistoricalMarket}]=await Promise.all([load('backtest'),load('models'),load('backtest-data')]);
// Identical scenario applied outside both engines; no asymmetric change to the old fill assumptions.
const originalQuotes=HistoricalMarket.prototype.quotes;
HistoricalMarket.prototype.quotes=function(now){return originalQuotes.call(this,now).map(q=>{if(c.policy==='v029_legacy'&&this.wholeLots&&q.book_source!=='OBSERVED')q={...q,bid_shares:Math.floor(q.bid_shares/2),ask_shares:Math.floor(q.ask_shares/2)};return assumedQuote(q,c.fill,data.frequency!=='DAILY');});};
const policy=c.policy.endsWith('legacy')?'legacy':c.policy;
const values={mode:'paper',codex_enabled:false,auto_execute:false,entry_policy:policy,execution_sizing:'deterministic',
  min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.01',watch_max_symbols:16,watch_min_amount:'20000000',minimum_fee:'20'};
if(c.policy==='v029_legacy'){delete values.entry_policy;delete values.execution_sizing;}
const settings=SettingsSchema.parse(values);
const report=await runBacktest({start:c.period.start,end:c.period.end,source:'csv',strategy:'rules',capital_profile:'custom',initial_cash:protocol.initial_cash,
  strategy_schedule:'interval',decision_interval_minutes:180,monitor_interval_seconds:300,watch_refresh_minutes:5,entry_cadence:'market',participation:'0.01',whole_lots:true},data,settings,undefined,new AbortController().signal);
if(!['COMPLETED','PARTIAL'].includes(report.status))throw Error('Replay did not complete');
const trades=tradeStatistics(report.fills,report.orders),daily=report.daily_equity;
let previous=100000,maxDailyLoss=0;for(const row of daily){maxDailyLoss=Math.max(maxDailyLoss,(previous-Number(row.equity))/previous*100);previous=Number(row.equity);}
const regime=at=>breadthState(Object.fromEntries(Object.keys(data.names).map(symbol=>[symbol,indicators(data.points.filter(p=>p.symbol===symbol&&p.at.slice(0,10)<at.slice(0,10)).map(p=>({date:p.at.slice(0,10),close:Number(p.close),high:Number(p.high),low:Number(p.low),volume:p.volume_shares}))) ])));
const byRegime={};for(const episode of trades.episodes){const key=regime(episode.entry_at);const row=byRegime[key]??={trades:0,pnl:0};row.trades++;row.pnl+=Number(episode.pnl);}
const archive=gzipSync(JSON.stringify(report));writeFileSync(output+'.run.json.gz',archive);
const result={case_index:index,...c,status:report.status,metrics:report.metrics,trades,maximum_daily_loss_pct:maxDailyLoss,annualized_return_pct:null,
  idle_close_pct:100-Number(report.metrics.average_close_exposure_pct??0),by_entry_regime:byRegime,
  quality:report.quality,audit_sha256:sha(archive)};
writeFileSync(output,JSON.stringify({...metadata,result},null,2)+'\n');
console.log(JSON.stringify({case:index,...c,return:report.metrics.return_pct,trades:trades.closed_trades,status:report.status}));
