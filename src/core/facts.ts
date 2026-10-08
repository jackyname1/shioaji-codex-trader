import { Store } from './store.js';
import { twDay } from './models.js';
const sources: Record<string,string> = {
  revenue_listed:'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
  revenue_otc:'https://mopsfin.twse.com.tw/opendata/t187ap05_O.csv',
  disclosures_listed:'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
  disclosures_otc:'https://mopsfin.twse.com.tw/opendata/t187ap04_O.csv',
};
// RFC4180 quoted fields, escaped quotes, CRLF, and embedded newlines.
export function csvRows(text: string): Record<string,string>[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('CSV 引號不完整');
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()?.map(x => x.replace(/^\uFEFF/,'').trim()) ?? [];
  if (!header.length || new Set(header).size !== header.length) throw new Error('CSV 標題不完整');
  return rows.filter(r => r.some(Boolean)).map(r => { if (r.length !== header.length) throw new Error('CSV 欄位數不符');
    return Object.fromEntries(header.map((key,i) => [key,r[i]!.trim()])); });
}
export async function collectFacts(store: Store, symbols: Set<string>, now: Date, signal: AbortSignal): Promise<{
  fundamentals:Record<string,unknown>;announcements:unknown[];limitations:string[] }> {
  const fundamentals: Record<string,unknown> = {}, announcements: unknown[] = [], limitations: string[] = [];
  for (const [name,url] of Object.entries(sources)) {
    const key = `official_${name}_${twDay(now)}`, ttl = name.startsWith('revenue') ? 3600000 : 900000;
    let cached = store.get<{at:string;rows:Record<string,string>[] }>(key);
    if (!cached || now.getTime() - Date.parse(cached.at) >= ttl) {
      try {
        const r = await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
        if (!r.ok || !r.body) throw new Error('來源無法取得');
        const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const {value,done} = await reader.read(); if (done) break;
          size += value.length; if (size > 10000000) throw new Error('資料過大'); chunks.push(value); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        const data = Buffer.concat(chunks); let text: string;
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { text = new TextDecoder('big5',{fatal:true}).decode(data); }
        const raw: unknown = url.endsWith('.csv') ? csvRows(text) : JSON.parse(text.replace(/^\uFEFF/,''));
        if (!Array.isArray(raw) || raw.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('官方欄位異常');
        cached = {at:now.toISOString(),rows:raw.map(x => Object.fromEntries(Object.entries(x as Record<string,unknown>).map(([k,v]) => [k.trim(),String(v).trim()])))};
        store.set(key,cached);
      } catch { limitations.push(name + '：官方來源無法取得，本輪不使用'); continue; }
    }
    for (const row of cached.rows) {
      const symbol = row['公司代號']; if (!symbol || !symbols.has(symbol)) continue;
      if (name.startsWith('revenue')) {
        const needed = ['資料年月','營業收入-當月營收','營業收入-去年同月增減(%)'];
        if (!needed.every(k => row[k])) { limitations.push(symbol + '：月營收欄位不完整'); continue; }
        const selected = [...needed,'出表日期','產業別','營業收入-上月比較增減(%)','累計營業收入-前期比較增減(%)'];
        fundamentals[symbol] = {source:url,retrieved_at:cached.at,data:Object.fromEntries(selected.filter(k => row[k]).map(k => [k,row[k]!.slice(0,1000)]))};
      } else if (row['主旨'] && row['發言日期']) announcements.push({symbol,source:url,retrieved_at:cached.at,
        published_date:row['發言日期'],published_time:row['發言時間'] ?? '',title:row['主旨'].slice(0,600),description:(row['說明'] ?? '').slice(0,1500)});
    }
  }
  return {fundamentals,announcements:announcements.slice(0,60),limitations};
}
