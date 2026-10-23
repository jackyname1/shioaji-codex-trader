export const ENTRY_STAGES=['CANDIDATE','DATA','TREND','TRIGGER','COST','RISK','SUBMITTED','FILLED'] as const;
export type EntryStage=typeof ENTRY_STAGES[number];
export type EntryCheck={stage:EntryStage;status:'PASS'|'BLOCK'|'NOT_REQUIRED';code:string;reason?:string};
export type EntryObserver=(check:EntryCheck)=>void;
interface CheckState {passed:boolean;not_required:boolean;blocked:boolean;first_at:string;last_at:string}
interface Signal {id:string;plan_id:string;symbol:string;sources:string[];first_at:string;last_at:string;
  checks:Partial<Record<EntryStage,CheckState>>;rejections:{stage:EntryStage;code:string;reason:string;first_at:string;last_at:string;samples:number}[]}
export interface EntryFunnelReport {version:1;complete:boolean;omitted_signals:number;unique_signals:number;
  definition:string;stages:{stage:EntryStage;observed:number;passed:number;not_required:number;blocked:number;unknown:number;converted:number}[];
  rejections:{stage:EntryStage;code:string;signals:number;samples:number}[];signals:Signal[]}
/** Observations from actual code branches, not inferred from free-text waiting messages.
 * One accepted strategy/symbol remains one signal across scans, lots and cross-session ROD retries.
 * PASS/NOT_REQUIRED are separate: no deterministic trend gate is invented for a legacy AI proposal.
 */
export class EntryFunnel {
  private rows=new Map<string,Signal>();
  private omitted=new Set<string>();
  constructor(private readonly maximum=100000){}
  observer(planId:string,symbol:string,source:string,at:Date):EntryObserver {
    return c=>this.record(planId,symbol,source,at,c);
  }
  record(planId:string,symbol:string,source:string,at:Date,c:EntryCheck):void {
    if(!planId||!Number.isFinite(at.getTime()))return;
    const id=planId+':'+symbol,stamp=at.toISOString();let row=this.rows.get(id);
    if(!row){if(this.rows.size>=this.maximum){this.omitted.add(id);return;}
      row={id,plan_id:planId,symbol,sources:[],first_at:stamp,last_at:stamp,checks:{},rejections:[]};this.rows.set(id,row);}
    if(!row.sources.includes(source))row.sources.push(source);
    row.last_at=stamp;
    const state=row.checks[c.stage]??{passed:false,not_required:false,blocked:false,first_at:stamp,last_at:stamp};
    if(c.status==='PASS')state.passed=true;
    if(c.status==='NOT_REQUIRED')state.not_required=true;
    if(c.status==='BLOCK'){
      state.blocked=true;
      let rejection=row.rejections.find(r=>r.stage===c.stage&&r.code===c.code);
      if(!rejection){rejection={stage:c.stage,code:c.code,reason:(c.reason??'').slice(0,700),first_at:stamp,last_at:stamp,samples:0};row.rejections.push(rejection);}
      rejection.samples++;rejection.last_at=stamp;
    }
    state.last_at=stamp;row.checks[c.stage]=state;
  }
  report():EntryFunnelReport {
    const rows=[...this.rows.values()],categories=new Map<string,{stage:EntryStage;code:string;signals:number;samples:number}>();
    for(const row of rows)for(const r of row.rejections){const k=r.stage+':'+r.code;
      const category=categories.get(k)??{stage:r.stage,code:r.code,signals:0,samples:0};
      category.signals++;category.samples+=r.samples;categories.set(k,category);}
    return {version:1,complete:this.omitted.size===0,omitted_signals:this.omitted.size,unique_signals:rows.length,
      definition:'唯一策略／股票；價格更新、五分鐘掃描、兩種 lot 與跨日重掛不重算。converted 要求此前各階段有實際 PASS 或 NOT_REQUIRED；未觀測階段維持 unknown，拒絕原因可重疊。',
      stages:ENTRY_STAGES.map((stage,i)=>({stage,observed:rows.filter(r=>r.checks[stage]).length,
        passed:rows.filter(r=>r.checks[stage]?.passed).length,not_required:rows.filter(r=>r.checks[stage]?.not_required).length,
        blocked:rows.filter(r=>r.checks[stage]?.blocked).length,unknown:rows.filter(r=>!r.checks[stage]).length,
        converted:rows.filter(r=>ENTRY_STAGES.slice(0,i+1).every(s=>r.checks[s]?.passed||r.checks[s]?.not_required)).length})),
      rejections:[...categories.values()].sort((a,b)=>b.signals-a.signals||a.code.localeCompare(b.code)),signals:structuredClone(rows)};
  }
}
