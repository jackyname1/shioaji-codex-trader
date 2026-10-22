import { addDays, twClock, twDay, type SessionDay } from './models.js';
import { Store } from './store.js';

const closed2026 = new Set(['2026-01-01','2026-02-12','2026-02-13','2026-02-15','2026-02-16',
  '2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-27','2026-02-28',
  '2026-04-03','2026-04-04','2026-04-05','2026-04-06','2026-05-01','2026-06-19',
  '2026-09-25','2026-09-28','2026-10-09','2026-10-10','2026-10-25','2026-10-26','2026-12-25']);
const weekday = (day: string): boolean => ![0, 6].includes(new Date(day + 'T00:00:00Z').getUTCDay());
// Unscheduled closures are explicit official announcements, never inferred from absent prices.
const exceptionalClosures:Record<string,{source:string;verified_at:string}>={
  '2023-08-03':{source:'https://investoredu.twse.com.tw/FileSystem/FileUpload/be0109d1-76a0-4412-a00d-58a88c6e1714.pdf',verified_at:'2023-08-03T00:00:00+08:00'},
  '2026-07-10':{source:'https://www.twse.com.tw/staticFiles/news/news/tsecnews/8a8216d69ef76943019f46cb86ae0110.pdf',verified_at:'2026-07-09T20:11:00+08:00'},
};
export const applyCalendarExceptions=(days:SessionDay[]):SessionDay[]=>days.map(day=>exceptionalClosures[day.day]
  ?{...day,...exceptionalClosures[day.day]!,known_at:exceptionalClosures[day.day]!.verified_at,scheduled_open:weekday(day.day)&&!closed2026.has(day.day),scheduled_settlement_open:weekday(day.day)&&!closed2026.has(day.day),open:false,settlement_open:false}:day);
export class TradingCalendar {
  private asof?:string;
  setAsOf(now:Date):void {this.asof=now.toISOString();}
  private visible(session:SessionDay|undefined):SessionDay|undefined {
    return session?.known_at&&Date.parse(session.known_at)>Date.parse(this.asof??new Date().toISOString())?{...session,open:session.scheduled_open??false,settlement_open:session.scheduled_settlement_open??false}:session;
  }
  constructor(readonly store: Store, readonly demo = false) {
    if (!store.session('2026-01-01')) {
      const days: SessionDay[] = [];
      for (let day = '2026-01-01'; day < '2027-01-01'; day = addDays(day, 1))
        days.push({ day, open: weekday(day) && !closed2026.has(day),settlement_open:['2026-02-12','2026-02-13'].includes(day)||weekday(day)&&!closed2026.has(day),
          source: 'https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date=20260101',
          verified_at: '2026-10-08T00:00:00+08:00' });
      store.saveSessions(applyCalendarExceptions(days));
    }
    // Upgrade persisted annual calendars while retaining the announcement's provenance.
    for(const [day,evidence] of Object.entries(exceptionalClosures))store.saveSessions([{day,open:false,settlement_open:false,...evidence,known_at:evidence.verified_at,scheduled_open:weekday(day)&&!closed2026.has(day),scheduled_settlement_open:weekday(day)&&!closed2026.has(day)}]);
    for(const day of ['2026-02-12','2026-02-13']){const existing=store.session(day);if(existing&&!existing.settlement_open)store.saveSessions([{...existing,settlement_open:true}]);}
  }
  isOpen(day: string): boolean { return this.visible(this.store.session(day))?.open ?? (this.demo && weekday(day)); }
  inSession(now: Date, lot: 'ODD' | 'COMMON' = 'ODD'): boolean {
    const day = twDay(now), clock = twClock(now);
    const start = lot === 'ODD' && day < '2026-12-07' ? '09:10' : '09:00';
    return this.isOpen(day) && clock >= start && clock < '13:30';
  }
  next(day: string, direction = 1): string {
    for (let n = 1; n < 370; n++) { const candidate = addDays(day, n * direction); if (this.isOpen(candidate)) return candidate; }
    throw new Error('尚未載入相鄰交易日的行事曆');
  }
  isSettlementOpen(day:string):boolean {const session=this.visible(this.store.session(day));return session?.settlement_open??this.isOpen(day);}
  nextSettlement(day:string,direction=1):string {
    for(let n=1;n<370;n++){const candidate=addDays(day,n*direction),session=this.store.session(candidate);
      if(!session&&!this.demo&&weekday(candidate))throw new Error('尚未載入相鄰營業日的交割行事曆');
      if(this.isSettlementOpen(candidate))return candidate;}
    throw new Error('尚未載入相鄰營業日的交割行事曆');
  }
  async refresh(year: number, signal?: AbortSignal,fetcher:typeof fetch=fetch): Promise<number> {
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('年份不合法');
    const source = `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date=${year}0101`;
    const response = await fetcher(source, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('證交所行事曆無法取得');
    const days = applyCalendarExceptions(parseCalendar(await response.json(), year, source));
    this.store.saveSessions(days); return days.length;
  }
}
export function parseCalendar(raw: unknown, year: number, source: string): SessionDay[] {
  const p = raw as { stat?: string; title?: string; fields?: string[]; data?: unknown[][] };
  if (p.stat?.toLowerCase() !== 'ok' || !p.title?.includes(String(year - 1911))
    || JSON.stringify(p.fields?.slice(0, 3)) !== JSON.stringify(['日期','名稱','說明']) || !p.data || p.data.length < 8)
    throw new Error('證交所行事曆欄位或年份不符');
  const closed = new Set<string>(), opened = new Set<string>(),settlementOnly=new Set<string>();
  for (const row of p.data) {
    const [day, name] = row;
    if (row.length < 3 || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || !day.startsWith(String(year)) || Number.isNaN(Date.parse(day)) || typeof name !== 'string')
      throw new Error('行事曆日期格式不符');
    if (name.includes('開始交易日') || name.includes('最後交易日')) opened.add(day); else closed.add(day);
    if(name.includes('僅辦理結算交割'))settlementOnly.add(day);
  }
  const days: SessionDay[] = [];
  for (let day = `${year}-01-01`; day < `${year + 1}-01-01`; day = addDays(day, 1))
    days.push({ day, open: opened.has(day) || (weekday(day) && !closed.has(day)),
      settlement_open:settlementOnly.has(day)||opened.has(day)||weekday(day)&&!closed.has(day),source, verified_at: new Date().toISOString() });
  return days;
}
