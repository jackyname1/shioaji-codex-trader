// Frozen descriptive ablation: neither parameter optimizer nor production qualification.
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {auditBacktest} from '../dist/src/core/backtest-audit.js';
import {tradeStatistics} from '../dist/src/core/performance.js';
import {tradeAttribution} from '../dist/src/core/trade-attribution.js';
const [baseline,output='private/repair-validation/benchmark']=process.argv.slice(2);
if(!baseline)throw new Error('Usage: node scripts/benchmark-repair.mjs BASELINE_CHECKOUT [OUTPUT_DIRECTORY]');
const protocolBytes=readFileSync('validation/repair-20261023/protocol.json'),protocol=JSON.parse(protocolBytes),sha=x=>createHash('sha256').update(x).digest('hex');
if(execFileSync('git',['rev-parse','HEAD'],{cwd:baseline,encoding:'utf8'}).trim()!==protocol.baseline_commit)throw new Error('Wrong baseline commit');
const raw=readFileSync(protocol.dataset),dataset=JSON.parse(gunzipSync(raw));
const codeHash=root=>{const hash=createHash('sha256');for(const folder of ['src/core','src/broker'])for(const file of readdirSync(join(root,folder)).filter(x=>x.endsWith('.ts')).sort())hash.update(folder+'/'+file+'\0').update(readFileSync(join(root,folder,file)));return hash.digest('hex');};
const metadata={execution_started_at:new Date().toISOString(),protocol,protocol_sha256:sha(protocolBytes),dataset_file_sha256:sha(raw),engine_hashes:{baseline:codeHash(baseline),current:codeHash(process.cwd())}};
const cases=protocol.periods.flatMap(period=>protocol.scenarios.flatMap(scenario=>protocol.arms.map(arm=>({period,scenario,arm}))));
mkdirSync(output,{recursive:true,mode:0o700});
const index=process.env.TRADER_REPAIR_CASE;
if(index===undefined){
 let next=0;await Promise.all(Array.from({length:3},async()=>{for(;;){const i=next++;if(i>=cases.length)return;
  await new Promise((done,fail)=>{const child=spawn(process.execPath,[process.argv[1],resolve(baseline),resolve(output)],{env:{...process.env,TRADER_REPAIR_CASE:String(i)},stdio:'inherit',timeout:240000});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error('Benchmark worker failed: '+i)));});
 }}));
 const results=cases.map((_,i)=>JSON.parse(readFileSync(join(output,'case-'+i+'.json'))));
 writeFileSync(join(output,'summary.json'),JSON.stringify({...metadata,results},null,2));
 if(results.some(x=>x.error||!x.audit?.passed))process.exitCode=1;
}else{
 const i=Number(index),c=cases[i];let result;
 try{
  const root=c.arm.engine==='baseline'?baseline:process.cwd(),load=p=>import(pathToFileURL(resolve(root,'dist/src/core',p+'.js')).href);
  const [{runBacktest},{SettingsSchema}]=await Promise.all([load('backtest'),load('models')]);
  const s=SettingsSchema.parse({entry_policy:'legacy',execution_sizing:'deterministic',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.01',
   watch_max_symbols:16,watch_min_amount:'20000000',minimum_fee:'20',min_net_profit_twd:'60',...c.arm.settings});
  const report=await runBacktest({start:c.period.start,end:c.period.end,source:'csv',strategy:'rules',capital_profile:'custom',initial_cash:protocol.initial_cash,
   strategy_every_sessions:5,entry_cadence:'market',monitor_interval_seconds:300,watch_refresh_minutes:5,execution_sizing:'deterministic',
   ...c.scenario,...(c.arm.research?{research:c.arm.research}:{})},dataset,s,undefined,new AbortController().signal);
  writeFileSync(join(output,'case-'+i+'.report.json.gz'),gzipSync(JSON.stringify(report)));
  result={index:i,...c,status:report.status,metrics:report.metrics,independent_trades:tradeStatistics(report.fills,report.orders),audit:auditBacktest(report),
   attribution:tradeAttribution(report.fills,report.orders),funnel:report.entry_funnel??null,
   turnover:report.fills.reduce((sum,f)=>sum+Number(f.price)*f.shares,0)/Number(protocol.initial_cash),
   limitations:report.limitations,quality:report.quality,dataset_sha256:report.dataset_sha256??null};
 }catch(error){result={index:i,...c,error:String(error)};}
 writeFileSync(join(output,'case-'+i+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({index:i,arm:c.arm.name,scenario:c.scenario,period:c.period.label,status:result.status,net:result.metrics?.net_pnl,error:result.error,audit:result.audit?.passed}));
}
