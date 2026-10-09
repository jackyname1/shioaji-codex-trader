import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { BacktestRequestSchema,formatBacktestReport,runBacktest,type BacktestProgress,type BacktestReport } from './backtest.js';
import { csvDataset,syntheticDataset } from './backtest-data.js';
import { shioajiDataset } from './backtest-source.js';
import { CodexAnalyst } from './codex.js';
import type { Settings } from './models.js';

export class BacktestController {
  report?:BacktestReport;
  progress:BacktestProgress={running:false,phase:'IDLE',day:'',points:0,total_points:0,codex_calls:0,message:'尚未執行歷史模擬'};
  private abort?:AbortController; private task?:Promise<void>;
  constructor(readonly root:string){}
  async restore():Promise<void>{
    try{const r=JSON.parse(await readFile(join(this.root,'latest.json'),'utf8')) as BacktestReport;
      if(r.version==='0.3.0'&&r.metrics&&r.request){this.report=r;this.progress.message='已載入上次歷史模擬報表';}}
    catch{/* First launch has no report. */}
  }
  start(raw:unknown,settings:Settings,csv?:string):string {
    if(this.task)throw new Error('回測上一輪仍在執行');
    const request=BacktestRequestSchema.parse(raw);
    if(request.source==='csv'&&csv===undefined)throw new Error('回測尚未選取 CSV');
    if(request.strategy==='codex'&&!settings.codex_enabled)throw new Error('回測 Codex 需先將 codex_enabled 設為 true 並在本機登入');
    this.abort=new AbortController();this.report=undefined;
    this.progress={running:true,phase:'LOADING',day:request.start,points:0,total_points:0,codex_calls:0,message:'準備獨立歷史模擬帳戶'};
    const update=(p:BacktestProgress):void=>{this.progress=p;};
    const signal=this.abort.signal,snapshotSettings=structuredClone(settings);
    this.task=(async()=>{
      try {
        const dataset=request.source==='sample'?syntheticDataset(request.start,request.end):request.source==='csv'?csvDataset(csv!):
          await shioajiDataset(request,snapshotSettings,join(this.root,'cache'),signal,update);
        signal.throwIfAborted();
        const analyst=request.strategy==='codex'?new CodexAnalyst(snapshotSettings,join(this.root,'codex-profile'),undefined,join(dirname(this.root),'codex-login')):undefined;
        this.report=await runBacktest(request,dataset,snapshotSettings,analyst?(input,sig)=>analyst.analyze(input,sig):undefined,signal,update);
        await mkdir(this.root,{recursive:true,mode:0o700});
        await writeFile(join(this.root,`report-${this.report.id}.json`),JSON.stringify(this.report,null,2),{mode:0o600});
        await writeFile(join(this.root,'latest.json'),JSON.stringify(this.report),{mode:0o600});
        this.progress={...this.progress,running:false,phase:this.report.status,codex_calls:this.report.metrics.codex_calls,message:'報表已保存，可匯出 JSON 或成交 CSV'};
      }catch(e){this.progress={...this.progress,running:false,phase:signal.aborted?'CANCELLED':'FAILED',
        message:signal.aborted?'已停止歷史模擬':e instanceof Error&&/^(回測|歷史|Shioaji HTTP|Codex|證交所|日期|股票)/.test(e.message)?e.message:'回測資料或分析未通過驗證，請核對 CSV 欄位、歷史日期、官方服務與 Codex 登入'};}
    })().finally(()=>{this.task=undefined;});
    return '已啟動獨立歷史模擬，交易監控可繼續使用';
  }
  cancel():string {this.abort?.abort();return '已要求停止回測；保留已完成的模擬結果';}
  async wait():Promise<void>{await this.task;}
  text():string {
    const p=this.progress;
    return `${p.phase} | ${p.day} | 行情 ${p.points}/${p.total_points} | Codex 呼叫 ${p.codex_calls}\n${p.message}`+
      (this.report?'\n\n'+formatBacktestReport(this.report):'');
  }
}
