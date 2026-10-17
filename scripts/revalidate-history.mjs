/** Diagnostic revalidation of logged execution requests, NOT a counterfactual portfolio backtest. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Risk} from '../dist/src/core/risk.js';
import {entryRiskIssues,entryQualityIssues} from '../dist/src/core/costs.js';
import {SettingsSchema,AccountSchema,OrderSchema} from '../dist/src/core/models.js';
import {Store} from '../dist/src/core/store.js';
import {TradingCalendar} from '../dist/src/core/calendar.js';
const [file,baseline,out]=process.argv.slice(2);if(!out)throw Error('node scripts/revalidate-history.mjs PRIVATE_HISTORY BASELINE_V024 PRIVATE_OUTPUT');
if(execFileSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='787a7af454143b2f3f49a7cbdb2c6b658189fd96')throw Error('Expected pinned v0.2.4 checkout');
const {Risk:OldRisk}=await import(pathToFileURL(resolve(baseline,'dist/src/core/risk.js')).href);
const {entryRiskIssues:oldEntryRisk}=await import(pathToFileURL(resolve(baseline,'dist/src/core/costs.js')).href);
const es=JSON.parse(readFileSync(file)).events,requests=new Map(),results=[];let snapshot;
const store=new Store(':memory:'),calendar=new TradingCalendar(store);
try{for(const e of es){
 if(e.stage==='SNAPSHOT'&&e.details?.universe)snapshot=e.details;
 if(e.stage==='SNAPSHOT'&&e.details?.request_id)requests.set(e.details.request_id,{r:e.details,snapshot});
 if(e.stage!=='SIZE_DECISION'||!e.details||e.details.action!=='BUY')continue;
 const advice=e.details,context=requests.get(advice.request_id);if(!context)continue;
 const {r,snapshot:snap}=context,at=new Date(r.asof),limitFields=Object.fromEntries(Object.entries(r.hard_limits).filter(([k])=>k in SettingsSchema.shape));
 const settings=SettingsSchema.parse({...limitFields,mode:'paper'}),lot=r.lots.find(l=>l.lot===advice.lot);
 const a=AccountSchema.parse({...Object.fromEntries(Object.entries(r.account).filter(([k])=>k in AccountSchema.shape)),asof:r.asof,complete:true,issue:'',orders:[]});
 const o=OrderSchema.parse({local_id:r.request_id,tag:r.request_id.slice(0,6),broker_id:'',symbol:r.symbol,action:'BUY',shares:advice.shares,limit_price:advice.limit_price,
 lot:advice.lot,status:'PREPARED',filled:0,created_at:r.asof,plan_id:r.plan_id,purpose:'ENTRY'});
 const base=snap?.account.daily_baseline_equity??null;
 const old=new OldRisk(settings,calendar).check(o,a,lot?.quote,r.instrument,at,base);
 old.push(...oldEntryRisk(o.shares,o.limit_price,r.protection,a,settings));
 const current=new Risk(settings,calendar),safe=current.settings,reasons=current.check(o,a,lot?.quote,r.instrument,at,base);
 reasons.push(...entryRiskIssues(o.shares,o.limit_price,r.protection,a,safe,o.symbol),...entryQualityIssues(o.shares,o.limit_price,r.protection,safe));
 results.push({at:r.asof,symbol:r.symbol,strategy_shares:r.condition?.shares,confirmed_shares:o.shares,confirmed_limit:o.limit_price,
 open_orders_omitted:r.account.open_orders.length,old_reasons:old,restored_reasons:reasons,complete_revalidation:r.account.open_orders.length===0,pass_old:r.account.open_orders.length?null:!old.length,pass_restored:r.account.open_orders.length?null:!reasons.length});
}}finally{store.close();}
mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'risk-revalidation.json'),JSON.stringify({diagnostic_only:true,results,
 limitations:['Checks the original logged account path, not the changed cash/holdings after rejecting orders.',
 'No hypothetical return is calculated; source request snapshots do not contain complete working-order objects.',
 'Cases with open_orders_omitted>0 need a full order journal and are not certified as complete revalidations.']},null,2));
console.log(JSON.stringify({requests:results.length,old_pass:results.filter(r=>r.pass_old).length,restored_pass:results.filter(r=>r.pass_restored).length,with_open_orders:results.filter(r=>r.open_orders_omitted).length}));
