import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ShioajiHttpBroker } from '../broker/http.js';
import { historicalKbars } from '../broker/historical-format.js';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { addDays, SettingsSchema, twDay, type Settings } from './models.js';
import { validateDataset, type HistoryDataset, type HistoryPoint } from './backtest-data.js';
import type { BacktestRequest, BacktestProgress } from './backtest.js';

export async function shioajiDataset(request:BacktestRequest,settings:Settings,cacheRoot:string,signal:AbortSignal,
  progress:(p:BacktestProgress)=>void,fetcher:typeof fetch=fetch):Promise<HistoryDataset> {
  if(request.end>=twDay(new Date()))throw new Error('回測真實資料必須使用已完成日期');
  const store=new Store(':memory:'),calendar=new TradingCalendar(store),broker=new ShioajiHttpBroker(store,SettingsSchema.parse({...settings,mode:'readonly'}),false,fetcher);
  const cancel=():void=>{void broker.close();};signal.addEventListener('abort',cancel,{once:true});
  const points:HistoryPoint[]=[],names:HistoryDataset['names']={};
  const report=(phase:string,message:string):void=>progress({running:true,phase,day:request.start,points:0,total_points:0,codex_calls:0,message});
  try {
    const health=z.object({status:z.literal('healthy'),token_stale:z.boolean().optional()}).parse(await broker.request('/health'));
    if(health.token_stale)throw new Error('回測資料服務登入已過期');
    for(let year=Number(request.start.slice(0,4));year<=Number(request.end.slice(0,4));year++) {
      if(year<2024)continue;
      if(!store.session(`${year}-01-01`)){report('CALENDAR',`讀取 ${year} 官方交易日曆`);await calendar.refresh(year,signal);}
    }
    let seedDate:string;
    try{seedDate=calendar.next(request.start,-1);}catch{
      const year=Number(request.start.slice(0,4))-1;
      await calendar.refresh(year,signal);seedDate=calendar.next(request.start,-1);
    }
    report('UNIVERSE',`讀取 ${seedDate} 歷史成交金額排行，建立本次歷史資料池`);
    const ranks=z.array(z.object({code:z.string(),name:z.string()})).parse(await broker.request('/data/scanner',
      {date:seedDate,scanner_type:'AmountRank',ascending:false,count:60}));
    const pool=ranks.filter(x=>/^[1-9]\d{3}$/.test(x.code)).slice(0,20);
    if(!pool.length)throw new Error('回測無法取得起始日前歷史股票池；不使用今日排行替代');
    await mkdir(cacheRoot,{recursive:true,mode:0o700});
    for(const row of pool) {
      signal.throwIfAborted();
      const meta=z.object({security_type:z.literal('STK'),code:z.literal(row.code),exchange:z.enum(['TSE','OTC'])}).parse(
        await broker.request(`/data/contracts/${row.code}/info?region=TW&security_type=STK`));
      names[row.code]={name:row.name,exchange:meta.exchange};
      for(let start=addDays(request.start,-150);start<=request.end;start=addDays(start,31)) {
        signal.throwIfAborted();const end=addDays(start,30)>request.end?request.end:addDays(start,30);
        report('HISTORY',`取得 ${row.code} ${start} 至 ${end} 歷史分鐘 K 線（唯讀；快取命中不重查）`);
        const key=createHash('sha256').update(JSON.stringify([settings.base_url,meta.exchange,row.code,start,end,'kbars-v2'])).digest('hex');
        let batch:HistoryPoint[]|undefined;
        try{const cached=JSON.parse(await readFile(join(cacheRoot,key+'.json'),'utf8')) as HistoryPoint[];
          if(cached.every(p=>p.symbol===row.code&&twDay(new Date(p.at))>=start&&twDay(new Date(p.at))<=end))batch=cached;
        }catch{/* Missing or invalid cache is fetched once. */}
        if(!batch){batch=historicalKbars(await broker.request('/data/kbars',{contract:{security_type:'STK',exchange:meta.exchange,code:row.code},start,end}),row.code)
          .filter(p=>twDay(new Date(p.at))>=start&&twDay(new Date(p.at))<=end);
          await writeFile(join(cacheRoot,key+'.json'),JSON.stringify(batch),{mode:0o600});}
        points.push(...batch);if(points.length>1000000)throw new Error('回測歷史資料超過 100 萬筆，請縮短日期區間或匯入較小 CSV');
      }
    }
    const verifiedCalendar=(store.db.prepare('SELECT value FROM sessions ORDER BY day').all() as {value:string}[]).map(r=>JSON.parse(r.value) as import('./models.js').SessionDay);
    return validateDataset({source:`Shioaji 歷史分鐘 K 線；${seedDate} 成交金額排行普通股前 ${pool.length} 檔`,synthetic:false,frequency:'MINUTE',points,names,calendar:verifiedCalendar,
      limitations:['資料池由起始日前的歷史排行建立，之後以當時已完成日 K 動態排序；沒有涵蓋全部上市櫃股票',
        '契約名稱與交易所由目前契約表核對，可能有存活者偏差；未涵蓋當時已退市或改碼股票',
        'Shioaji 分鐘 K 線來自普通股票市場；它不是零股歷史五檔，零股成交只能近似估計']});
  }finally {signal.removeEventListener('abort',cancel);await broker.close();store.close();}
}
