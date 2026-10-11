import { readFile,writeFile,mkdir,rename,readdir,stat } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BacktestRequestSchema,formatBacktestReport,runBacktest,type BacktestProgress,type BacktestReport,type ReplayFrame } from './backtest.js';
import { ReplayClock,type ReplayCommand } from './replay-clock.js';
import { buildChart,ChartRequestSchema,type ChartData } from './chart.js';
import type { HistoryDataset } from './backtest-data.js';
import type { AnalystEvent } from './codex.js';
import { csvDataset,syntheticDataset } from './backtest-data.js';
import { shioajiDataset } from './backtest-source.js';
import { CodexAnalyst } from './codex.js';
import type { Settings } from './models.js';

export interface BacktestSummary {id:string;created_at:string;status:string;start:string;end:string;synthetic:boolean;
  strategy:string;schedule:string;monitor_seconds:number;net_pnl:string;return_pct:string;drawdown_pct:string;calls:number}
export function reportSummary(r:BacktestReport):BacktestSummary {
  return {id:r.id,created_at:r.created_at,status:r.status,start:r.request.start,end:r.request.end,synthetic:r.synthetic,strategy:r.request.strategy,
    schedule:r.request.strategy_schedule==='fixed'?r.request.strategy_times.join(' / '):r.request.decision_interval_minutes+' 分鐘',
    monitor_seconds:r.request.monitor_interval_seconds,net_pnl:r.metrics.net_pnl,return_pct:r.metrics.return_pct,
    drawdown_pct:r.metrics.max_drawdown_pct,calls:r.metrics.codex_calls};
}
export class BacktestController {
  clock=new ReplayClock();frame?:ReplayFrame;analystEvents:AnalystEvent[]=[];
  private dataset?:HistoryDataset;
  report?:BacktestReport;history:BacktestSummary[]=[];comparisons:BacktestSummary[]=[];
  progress:BacktestProgress={running:false,phase:'IDLE',day:'',points:0,total_points:0,codex_calls:0,message:'選擇日期與排程，即可開始全自動測試'};
  private abort?:AbortController;private task?:Promise<void>;
  constructor(readonly root:string){}
  private useReport(r:BacktestReport):void {
    this.report=r;this.frame=r.final_frame;
    this.progress={running:false,phase:r.status,day:r.request.end,points:0,total_points:0,
      codex_calls:r.metrics.codex_calls,message:'已載入測試結果，可查看與匯出'};
  }
  async restore():Promise<void>{
    try{const r=JSON.parse(await readFile(join(this.root,'latest.json'),'utf8')) as BacktestReport;
      if(['0.1.0','0.4.0','0.5.0'].includes(r.version)&&r.quality&&r.metrics&&r.request)this.useReport(r);
      else this.progress.message='上一版報表仍保留在本機；新版請重新執行測試';
    }catch{/* New profile. */}
    await this.loadHistory();
  }
  private async loadHistory():Promise<void>{
    try{const names=(await readdir(this.root)).filter(n=>/^report-[a-f0-9-]{36}\.json$/.test(n));
      const files=await Promise.all(names.map(async name=>({name,time:(await stat(join(this.root,name))).mtimeMs})));
      const result:BacktestSummary[]=[];
      for(const f of files.sort((a,b)=>b.time-a.time).slice(0,30))try {
        const r=JSON.parse(await readFile(join(this.root,f.name),'utf8')) as BacktestReport;
        if(['0.1.0','0.4.0','0.5.0'].includes(r.version)&&r.quality)result.push(reportSummary(r));
      }catch{/* A damaged report cannot affect trading. */}
      this.history=result;
    }catch{this.history=[];}
  }
  async select(id:string):Promise<string>{
    if(this.task)throw new Error('回測執行中不能切換報表');
    if(!/^[a-f0-9-]{36}$/.test(id)||!this.history.some(r=>r.id===id))throw new Error('回測報表識別不合法');
    const r=JSON.parse(await readFile(join(this.root,`report-${id}.json`),'utf8')) as BacktestReport;
    if(r.id!==id||!['0.1.0','0.4.0','0.5.0'].includes(r.version)||!r.quality)throw new Error('回測報表未通過驗證');
    this.useReport(r);this.dataset=undefined;return '已載入測試結果';
  }
  private async save(report:BacktestReport):Promise<void>{
    await mkdir(this.root,{recursive:true,mode:0o700});
    const temporary=join(this.root,'latest-'+randomUUID()+'.tmp');
    await writeFile(join(this.root,`report-${report.id}.json`),JSON.stringify(report,null,2),{mode:0o600});
    await writeFile(temporary,JSON.stringify(report),{mode:0o600});await rename(temporary,join(this.root,'latest.json'));
    this.history=[reportSummary(report),...this.history.filter(r=>r.id!==report.id)].slice(0,30);
  }
  start(raw:unknown,settings:Settings,csv?:string):string {
    if(this.task)throw new Error('回測上一輪仍在執行');const request=BacktestRequestSchema.parse(raw);
    if(request.source==='csv'&&csv===undefined)throw new Error('回測尚未選取 CSV');
    if(request.strategy==='codex'&&!settings.codex_enabled)throw new Error('回測 Codex 需先啟用並在本機登入');
    this.abort=new AbortController();this.comparisons=[];this.frame=undefined;this.dataset=undefined;this.report=undefined;this.analystEvents=[];
    this.clock=new ReplayClock();this.clock.setSpeed(request.playback_speed);
    const intervals=request.comparison_intervals.length?request.comparison_intervals:[request.decision_interval_minutes];
    this.progress={running:true,phase:'LOADING',day:request.start,points:0,total_points:0,codex_calls:0,message:'準備歷史資料與獨立模擬帳戶',run:1,total_runs:intervals.length};
    const signal=this.abort.signal,snapshotSettings=structuredClone(settings);let consumed=0;
    this.task=(async()=>{
      try{const dataset=request.source==='sample'?syntheticDataset(request.start,request.end):request.source==='csv'?csvDataset(csv!):
          await shioajiDataset(request,snapshotSettings,join(this.root,'cache'),signal,p=>{this.progress={...p,run:1,total_runs:intervals.length};});
        signal.throwIfAborted();
        this.dataset=dataset;const datasetId=randomUUID();
        await mkdir(this.root,{recursive:true,mode:0o700});
        await writeFile(join(this.root,'market-'+datasetId+'.json'),JSON.stringify(dataset),{mode:0o600});
        const analyst=request.strategy==='codex'?new CodexAnalyst(snapshotSettings,join(this.root,'codex-profile'),undefined,join(dirname(this.root),'codex-login'),event=>{this.analystEvents.push(event);this.analystEvents=this.analystEvents.slice(-80);}):undefined;
        for(let index=0;index<intervals.length;index++){
          if(signal.aborted)break;
          if(request.strategy==='codex'&&consumed>=request.max_codex_calls){this.progress.message='整批 Codex 呼叫額度已用完，其餘比較未執行';break;}
          const runRequest={...request,comparison_intervals:[],decision_interval_minutes:intervals[index]!,max_codex_calls:Math.max(1,request.max_codex_calls-consumed)};
          const r=await runBacktest(runRequest,dataset,snapshotSettings,analyst?(input,sig)=>analyst.analyze(input,sig):undefined,signal,
            p=>{this.progress={...p,codex_calls:consumed+p.codex_calls,run:index+1,total_runs:intervals.length};},this.clock,frame=>{this.frame=frame;});
          r.dataset_id=datasetId;
          this.report=r;consumed+=r.metrics.codex_calls;this.comparisons.push(reportSummary(r));await this.save(r);
          if(r.status==='CANCELLED')break;
        }
        const exhausted=this.comparisons.length<intervals.length&&!signal.aborted;
        this.progress={...this.progress,running:false,phase:signal.aborted?'CANCELLED':exhausted?'PARTIAL':this.report?.status??'FAILED',codex_calls:consumed,
          message:exhausted?'呼叫上限為整批共用；尚未執行所有比較。已完成結果可查看與匯出':'結果已保存，可比較排程、查看成交與匯出'};
      }catch(e){this.progress={...this.progress,running:false,phase:signal.aborted?'CANCELLED':'FAILED',
        message:signal.aborted?'已停止測試；已完成結果保留':e instanceof Error&&/^(回測|歷史|Shioaji HTTP|Codex|證交所|日期|股票)/.test(e.message)?e.message:'回測資料或分析未通過驗證，請核對歷史日期、暖機資料、官方服務與 Codex 登入'};}
    })().finally(()=>{this.task=undefined;});
    return intervals.length>1?`已啟動 ${intervals.length} 組自動比較；Codex 呼叫上限為整批共用`:'已啟動全自動歷史測試，交易監控持續';
  }
  control(command:ReplayCommand):string{if(!this.task)throw new Error('回測尚未執行');this.clock.command(command);return command==='pause'?'回放已暫停':command==='step'?'前進一個事件':'回放已繼續';}
  speed(value:number):string{this.clock.setSpeed(value);return value?'回放速度 '+value+'×':'使用最快速度估算';}
  async marketData():Promise<HistoryDataset>{
    if(this.dataset)return this.dataset;
    const id=this.report?.dataset_id;if(!id||! /^[a-f0-9-]{36}$/.test(id))throw new Error('回測舊版報表沒有保存原始行情，請重新執行');
    this.dataset=JSON.parse(await readFile(join(this.root,'market-'+id+'.json'),'utf8')) as HistoryDataset;return this.dataset;
  }
  async chart(raw:unknown):Promise<ChartData>{
    const request=ChartRequestSchema.parse(raw);
    const cutoff=this.progress.running?this.frame?.at:this.report?.asof;
    if(!cutoff)throw new Error('回測尚未提供可查看的模擬時間');
    const dataset=await this.marketData();return buildChart(dataset.points,request,cutoff,dataset.names[request.symbol]?.name,dataset.source);
  }
  cancel():string{this.abort?.abort();return '已要求停止測試，保存已完成結果';}
  async wait():Promise<void>{await this.task;}
  text():string{const p=this.progress;return `${p.phase} | ${p.day} | ${p.points}/${p.total_points} | Codex ${p.codex_calls}\n${p.message}`+
      (this.report?'\n\n'+formatBacktestReport(this.report):'');}
}
