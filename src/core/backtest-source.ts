import { cachedHistory } from './history-cache.js';
import { replayBounds } from './backtest.js';
import { z } from 'zod';
import { ShioajiHttpBroker } from '../broker/http.js';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { addDays, SettingsSchema, twDay, type Settings } from './models.js';
import { validateDataset, type HistoryDataset, type HistoryPoint } from './backtest-data.js';
import { BrokerHealthSchema, marketReady } from '../broker/health.js';
import type { BacktestRequest, BacktestProgress } from './backtest.js';

export async function shioajiDataset(request:BacktestRequest,settings:Settings,cacheRoot:string,signal:AbortSignal,
  progress:(p:BacktestProgress)=>void,fetcher:typeof fetch=fetch):Promise<HistoryDataset> {
  const bounds=replayBounds(request);
  if(request.start<'2020-03-02'||request.end>twDay(new Date()))throw new Error('回測日期需介於 2020-03-02 與現在');
  const store=new Store(':memory:'),calendar=new TradingCalendar(store),broker=new ShioajiHttpBroker(store,SettingsSchema.parse({...settings,mode:'readonly'}),false,fetcher);
  const cancel=():void=>{void broker.close();};signal.addEventListener('abort',cancel,{once:true});
  const points:HistoryPoint[]=[],names:HistoryDataset['names']={};
  const report=(phase:string,message:string):void=>progress({running:true,phase,day:request.start,points:0,total_points:0,codex_calls:0,message});
  try {
    z.object({simulation:z.literal(false)}).parse(await broker.request('/info'));
    const health=BrokerHealthSchema.parse(await broker.request('/health'));
    if(!marketReady(health))throw new Error('回測行情登入尚未就緒，請稍候或重新連線');
    for(let year=Number(request.start.slice(0,4));year<=Number(request.end.slice(0,4));year++) {
      if(year<2020)continue;
      if(!store.session(`${year}-01-01`)){report('CALENDAR',`讀取 ${year} 官方交易日曆`);await calendar.refresh(year,signal);}
    }
    let seedDate:string|undefined;
    let pool:{code:string;name:string}[];
    if(request.symbols.length) {
      pool=request.symbols.map(code=>({code,name:code}));
      report('UNIVERSE',`使用指定的 ${pool.length} 檔歷史測試股票`);
    } else {
      try{seedDate=calendar.next(request.start,-1);}catch{
        const year=Number(request.start.slice(0,4))-1;
        await calendar.refresh(year,signal);seedDate=calendar.next(request.start,-1);
      }
      report('UNIVERSE',`讀取 ${seedDate} 歷史成交金額排行，建立本次歷史資料池`);
      const ranks=z.array(z.object({code:z.string(),name:z.string()})).parse(await broker.request('/data/scanner',
        {date:seedDate,scanner_type:'AmountRank',ascending:false,count:60}));
      pool=ranks.filter(x=>/^[1-9]\d{3}$/.test(x.code)).slice(0,20);
    }
    if(!pool.length)throw new Error('回測無法取得起始日前歷史股票池；不使用今日排行替代');
    for(const row of pool) {
      signal.throwIfAborted();
      const meta=z.object({security_type:z.literal('STK'),code:z.literal(row.code),name:z.string().optional(),exchange:z.enum(['TSE','OTC'])}).parse(
        await broker.request(`/data/contracts/${row.code}/info?region=TW&security_type=STK`));
      names[row.code]={name:meta.name??row.name,exchange:meta.exchange};
      const warmup=addDays(request.start,-150);
      const batch=await cachedHistory(broker,cacheRoot,row.code,meta.exchange,warmup<'2020-03-02'?'2020-03-02':warmup,
        request.end,bounds.end,signal,message=>report('HISTORY',message));
      points.push(...batch);
      if(points.length>3000000)throw new Error('回測歷史資料超過 300 萬筆，請分段測試或縮小股票池');
    }
    const verifiedCalendar=(store.db.prepare('SELECT value FROM sessions ORDER BY day').all() as {value:string}[]).map(r=>JSON.parse(r.value) as import('./models.js').SessionDay);
    return validateDataset({source:`Shioaji 歷史分鐘 K 線；${seedDate ? `${seedDate} 成交金額排行普通股前 ${pool.length} 檔` : `指定 ${pool.length} 檔股票`}`,synthetic:false,frequency:'MINUTE',points,names,calendar:verifiedCalendar,
      limitations:[seedDate ? '資料池由起始日前的歷史排行建立，之後以當時已完成日 K 動態排序；沒有涵蓋全部上市櫃股票' : '使用指定股票池，以當時已完成日 K 動態排序；沒有涵蓋全部上市櫃股票',
        '契約名稱與交易所由目前契約表核對，可能有存活者偏差；未涵蓋當時已退市或改碼股票',
        'Shioaji 分鐘 K 線來自普通股票市場；它不是零股歷史五檔，零股成交只能近似估計']});
  }finally {signal.removeEventListener('abort',cancel);await broker.close();store.close();}
}
