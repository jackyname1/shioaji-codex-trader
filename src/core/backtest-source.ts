import { cachedHistory } from './history-cache.js';
import { replayBounds } from './backtest.js';
import { z } from 'zod';
import { ShioajiHttpBroker } from '../broker/http.js';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { addDays, SettingsSchema, twDay, type Settings } from './models.js';
import { validateDataset,partitionReplayHistory,MAX_HISTORY_POINTS, type HistoryDataset, type HistoryPoint } from './backtest-data.js';
import { BrokerHealthSchema, marketReady } from '../broker/health.js';
import { cachedUniverse } from './universe-cache.js';
import type { BacktestRequest, BacktestProgress } from './backtest.js';

export async function shioajiDataset(request:BacktestRequest,settings:Settings,cacheRoot:string,signal:AbortSignal,
  progress:(p:BacktestProgress)=>void,fetcher:typeof fetch=fetch,dependencies:{history?:typeof cachedHistory}={}):Promise<HistoryDataset> {
  const bounds=replayBounds(request);
  if(request.start<'2020-03-02'||request.end>twDay(new Date()))throw new Error('回測日期需介於 2020-03-02 與現在');
  const store=new Store(':memory:'),calendar=new TradingCalendar(store),broker=new ShioajiHttpBroker(store,SettingsSchema.parse({...settings,mode:'readonly'}),false,fetcher);
  const cancel=():void=>{void broker.close();};signal.addEventListener('abort',cancel,{once:true});
  const points:HistoryPoint[]=[],dailyHistory:HistoryPoint[]=[],minuteStarts:Record<string,string>={},names:HistoryDataset['names']={},normalization={duplicates:0,revisions:0};
  const readHistory=dependencies.history??cachedHistory;
  const report=(phase:string,message:string):void=>progress({running:true,phase,day:request.start,points:points.length,total_points:0,codex_calls:0,message});
  try {
    z.object({simulation:z.literal(false)}).parse(await broker.request('/info'));
    const health=BrokerHealthSchema.parse(await broker.request('/health'));
    if(!marketReady(health))throw new Error('回測行情登入尚未就緒，請稍候或重新連線');
    for(let year=Number(request.start.slice(0,4));year<=Number(request.end.slice(0,4));year++) {
      if(year<2020)continue;
      if(!store.session(`${year}-01-01`)){report('CALENDAR',`讀取 ${year} 官方交易日曆`);await calendar.refresh(year,signal);}
    }
    let dailyUniverse:HistoryDataset['daily_universe'];
    let pool:{code:string;name:string}[];
    if(request.symbols.length) {
      pool=request.symbols.map(code=>({code,name:code}));
      for(const row of pool)minuteStarts[row.code]=request.start;
      report('UNIVERSE',`使用指定的 ${pool.length} 檔歷史測試股票`);
    } else {
      dailyUniverse={};const all=new Map<string,{code:string;name:string}>();
      for(let day=request.start;day<=request.end;day=addDays(day,1)){
        signal.throwIfAborted();if(!calendar.isOpen(day))continue;
        let asof:string;
        try{asof=calendar.next(day,-1);}catch{
          await calendar.refresh(Number(day.slice(0,4))-1,signal);asof=calendar.next(day,-1);
        }
        report('UNIVERSE',`${day}：讀取前一交易日 ${asof} 成交金額排行`);
        const ranks=(await cachedUniverse(broker,cacheRoot,asof,signal)).slice(0,settings.candidate_pool_size);
        dailyUniverse[day]={asof,symbols:ranks.map(r=>r.code)};
        for(const row of ranks){all.set(row.code,{code:row.code,name:row.name});minuteStarts[row.code]??=day;}
      }
      pool=[...all.values()];
    }
    if(!pool.length)throw new Error('回測無法取得起始日前歷史股票池；不使用今日排行替代');
    for(const [index,row] of pool.entries()) {
      signal.throwIfAborted();
      const meta=z.object({security_type:z.literal('STK'),code:z.literal(row.code),name:z.string().optional(),exchange:z.enum(['TSE','OTC'])}).parse(
        await broker.request(`/data/contracts/${row.code}/info?region=TW&security_type=STK`));
      names[row.code]={name:meta.name??row.name,exchange:meta.exchange};
      const warmup=addDays(request.start,-150);
      const batch=await readHistory(broker,cacheRoot,row.code,meta.exchange,warmup<'2020-03-02'?'2020-03-02':warmup,
        request.end,bounds.end,signal,message=>report('HISTORY',message),counts=>{normalization.duplicates+=counts.duplicates;normalization.revisions+=counts.revisions;});
      signal.throwIfAborted();
      const retained=partitionReplayHistory(batch,minuteStarts[row.code]!);
      if(points.length+dailyHistory.length+retained.points.length+retained.daily_history.length>MAX_HISTORY_POINTS)
        throw new Error('回測歷史行情與暖機日 K 合計超過 300 萬筆，請分段測試；每日股票池未截斷');
      for(const p of retained.points)points.push(p);for(const p of retained.daily_history)dailyHistory.push(p);
      report('HISTORY',`歷史資料 ${index+1}/${pool.length} 檔 · 分鐘行情 ${points.length} 筆 · 暖機日 K ${dailyHistory.length} 筆`);
    }
    const verifiedCalendar=(store.db.prepare('SELECT value FROM sessions ORDER BY day').all() as {value:string}[]).map(r=>JSON.parse(r.value) as import('./models.js').SessionDay);
    return validateDataset({source:`Shioaji 歷史分鐘 K 線；${dailyUniverse ? `每日以前一交易日排行更新，上限 ${settings.candidate_pool_size} 檔（聯集 ${pool.length} 檔）` : `指定 ${pool.length} 檔股票`}`,synthetic:false,frequency:'MINUTE',points,daily_history:dailyHistory,minute_starts:minuteStarts,names,normalization,calendar:verifiedCalendar,daily_universe:dailyUniverse,
      limitations:[dailyUniverse ? '每日資料池依前一交易日歷史成交金額排行更新；只有當日成員與既有持倉可供策略使用，不提前展示未來入池股票；沒有涵蓋全市場' : '使用指定固定股票池，以當時已完成日 K 動態排序；沒有涵蓋全部上市櫃股票',
        '契約名稱與交易所由目前契約表核對，可能有存活者偏差；未涵蓋當時已退市或改碼股票',
        '入池前的完整可用分鐘資料整理為每日 OHLC、成交量及成交金額作指標暖機；入池起日至回放截止保留所有可用分鐘行情，離池後持倉仍可監控',
        '日 K 圖可查看暖機資料；分鐘圖與分鐘 CSV 只含入池後保留的分鐘行情，完整 JSON 另含暖機日 K、每日股票池與入池日期',
        'Shioaji 分鐘 K 線來自普通股票市場；它不是零股歷史五檔，零股成交只能近似估計']});
  }finally {signal.removeEventListener('abort',cancel);await broker.close();store.close();}
}

