export interface ClockSample {source:string;offset_ms:number;uncertainty_ms:number;rtt_ms:number}
export interface ClockDiagnostic {at:string;status:'OK'|'DRIFT'|'UNKNOWN';offset_ms:number|null;samples:ClockSample[];message:string}
export function clockConsensus(samples:ClockSample[],at=new Date().toISOString()):ClockDiagnostic{
  const valid=samples.filter(s=>[s.offset_ms,s.uncertainty_ms,s.rtt_ms].every(Number.isFinite)&&s.rtt_ms>=0&&s.rtt_ms<=5000&&s.uncertainty_ms>=500);
  const independent=[...new Map(valid.map(s=>[s.source,s])).values()].sort((a,b)=>a.offset_ms-b.offset_ms);
  if(independent.length<2||independent.at(-1)!.offset_ms-independent[0]!.offset_ms>2000)
    return {at,status:'UNKNOWN',offset_ms:null,samples:independent,message:'時間來源不足或不一致，無法判定；本機 Shioaji health 時間不是券商校時依據'};
  const offset=independent.reduce((n,s)=>n+s.offset_ms,0)/independent.length;
  const drift=Math.abs(offset)-Math.max(...independent.map(s=>s.uncertainty_ms))>5000;
  return {at,status:drift?'DRIFT':'OK',offset_ms:Math.round(offset),samples:independent,
    message:`HTTPS 粗略時差 ${offset>=0?'+':''}${(offset/1000).toFixed(1)} 秒（遠端－本機）；${drift?'請處理 Windows 校時後再登入':'僅供秒級診斷'}，不是券商時間或簽章有效性保證；未修改系統時間`};
}
/** User-triggered, read-only TLS checks. No OS commands, elevation, NTP writes or signing-clock overrides. */
export async function diagnoseClock(fetcher:typeof fetch=fetch):Promise<ClockDiagnostic>{
  const sources=['https://www.twse.com.tw/','https://www.microsoft.com/','https://www.google.com/'];
  const rows=await Promise.allSettled(sources.map(async source=>{
    const start=Date.now(),tick=performance.now();
    const response=await fetcher(source,{method:'HEAD',redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(6000)});
    const end=Date.now(),elapsed=performance.now()-tick,remote=Date.parse(response.headers.get('date')??'');
    if(!response.ok||!Number.isFinite(remote)||Number(response.headers.get('age')??0)>0||Math.abs(end-start-elapsed)>250)throw Error('Unusable time source');
    return {source:new URL(source).hostname,offset_ms:remote+500-(start+end)/2,uncertainty_ms:500+elapsed/2,rtt_ms:elapsed};
  }));
  return clockConsensus(rows.flatMap(r=>r.status==='fulfilled'?[r.value]:[]));
}
