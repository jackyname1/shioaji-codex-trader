import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {runBacktest} from '../dist/src/core/backtest.js';
import {SettingsSchema} from '../dist/src/core/models.js';
import {tradeAttribution} from '../dist/src/core/trade-attribution.js';
const protocolPath=resolve(process.argv[3]??'validation/repair-20261023/history-protocol.json');
const protocolBytes=readFileSync(protocolPath),protocol=JSON.parse(protocolBytes),sha=b=>createHash('sha256').update(b).digest('hex');
const output=resolve(process.argv[2]??'private/repair-validation/historical'),index=process.env.TRADER_HISTORY_CASE;
const cases=protocol.folds.flatMap(fold=>protocol.scenarios.flatMap(scenario=>protocol.arms.map(arm=>({fold,scenario,arm}))));
for(const settings of protocol.sensitivity.settings)cases.push({fold:protocol.folds.find(f=>f.label===protocol.sensitivity.fold),scenario:protocol.scenarios.find(s=>s.fill_assumption===protocol.sensitivity.scenario),arm:{name:'sensitivity_'+Object.entries(settings).map(x=>x.join('_')).join('_'),settings}});
mkdirSync(output,{recursive:true,mode:0o700});
const raw=readFileSync(protocol.dataset),codeHash=createHash('sha256');for(const folder of ['src/core','src/broker'])for(const file of readdirSync(folder).filter(f=>f.endsWith('.ts')).sort())codeHash.update(folder+'/'+file+'\0').update(readFileSync(join(folder,file)));
const metadata={execution_started_at:new Date().toISOString(),protocol_sha256:sha(protocolBytes),dataset_file_sha256:sha(raw),engine_sha256:codeHash.digest('hex'),protocol};
if(index===undefined){
 let next=0;await Promise.all(Array.from({length:2},async()=>{for(;;){const i=next++;if(i>=cases.length)return;
  await new Promise((done,fail)=>{const child=spawn(process.execPath,[process.argv[1],output,protocolPath],{env:{...process.env,TRADER_HISTORY_CASE:String(i)},stdio:'inherit',timeout:300000});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error('Historical worker failed: '+i)));});
 }}));
 const results=cases.map((_,i)=>JSON.parse(readFileSync(join(output,'case-'+i+'.json'))));
 writeFileSync(join(output,'summary.json'),JSON.stringify({...metadata,results},null,2));if(results.some(r=>r.error||!r.audit?.passed))process.exitCode=1;
}else{
 const i=Number(index),c=cases[i];let result;
 try{
  const full=JSON.parse(gunzipSync(raw)),pools=Object.fromEntries(Object.entries(full.daily_universe).filter(([day])=>day>=c.fold.start&&day<=c.fold.end));
  const symbols=new Set(Object.values(pools).flatMap(p=>p.symbols)),bySymbol=new Map();
  for(const p of full.points)if(symbols.has(p.symbol)&&p.at.slice(0,10)<=c.fold.end){const rows=bySymbol.get(p.symbol)??[];rows.push(p);bySymbol.set(p.symbol,rows);}
  const points=[...bySymbol.values()].flatMap(rows=>[...rows.filter(p=>p.at.slice(0,10)<c.fold.start).slice(-150),...rows.filter(p=>p.at.slice(0,10)>=c.fold.start)]);
  const dataset={...full,points,names:Object.fromEntries(Object.entries(full.names).filter(([symbol])=>symbols.has(symbol))),daily_universe:pools};
  const settings=SettingsSchema.parse({entry_policy:'legacy',execution_sizing:'deterministic',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.01',
    watch_max_symbols:16,watch_min_amount:'20000000',minimum_fee:'20',min_net_profit_twd:'60',...c.arm.settings});
  const report=await runBacktest({start:c.fold.start,end:c.fold.end,source:'csv',strategy:'rules',capital_profile:'custom',initial_cash:protocol.initial_cash,
    strategy_every_sessions:5,entry_cadence:'market',monitor_interval_seconds:300,watch_refresh_minutes:5,execution_sizing:'deterministic',max_codex_calls:2000,
    ...c.scenario,...(c.arm.research?{research:c.arm.research}:{})},dataset,settings,undefined,new AbortController().signal);
  writeFileSync(join(output,'case-'+i+'.report.json.gz'),gzipSync(JSON.stringify(report)));
  result={index:i,...c,status:report.status,metrics:report.metrics,audit:report.diagnostics.audit,attribution:tradeAttribution(report.fills,report.orders),
    funnel:{...report.entry_funnel,signals:undefined},quality:report.quality,limitations:report.limitations,dataset_sha256:report.dataset_sha256,
    subset:{symbols:symbols.size,points:points.length,rule:'all dated members and up to 150 preceding completed bars; no outcome filtering'},
    turnover:report.fills.reduce((sum,f)=>sum+Number(f.price)*f.shares,0)/Number(protocol.initial_cash)};
 }catch(error){result={index:i,...c,error:String(error)};}
 writeFileSync(join(output,'case-'+i+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({index:i,fold:c.fold.label,arm:c.arm.name,scenario:c.scenario.fill_assumption,status:result.status,net:result.metrics?.net_pnl,error:result.error,audit:result.audit?.passed}));
}
