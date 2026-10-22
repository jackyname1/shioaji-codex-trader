"""Fetch dated TWSE ALLBUT0999 cross sections; daily turnover pool uses prior completed session.
No fixed watchlist. Cash stocks are approximated by four-digit identifiers 1xxx-8xxx;
historical security-master/status, OTC, adjusted returns and odd-lot books are NOT supplied.
Usage: python scripts/fetch-market-panel.py --start 2024-01-01 --end 2025-12-31 --output FILE.json.gz --cache DIRECTORY
"""
import argparse,concurrent.futures,datetime as dt,gzip,hashlib,json,pathlib,re,time,urllib.request

def retrieve(item):
    day,cache=item;date=day.replace('-','');url=f'https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={date}&type=ALLBUT0999'
    path=cache/(day+'.json')
    if not path.exists():
        for attempt in range(3):
            try:
                raw=urllib.request.urlopen(url,timeout=30).read();obj=json.loads(raw)
                if not isinstance(obj,dict) or 'stat' not in obj: raise ValueError('Invalid official response')
                if obj.get('stat')=='OK' and obj.get('date')!=date: raise ValueError('Wrong response date')
                if obj.get('stat')!='OK' and not re.search('沒有|查無|很抱歉',obj.get('stat','')): raise ValueError('Unknown response status')
                path.write_bytes(raw);break
            except Exception:
                if attempt==2:raise
                time.sleep(attempt+1)
    raw=path.read_bytes();x=json.loads(raw)
    if x.get('stat')=='OK' and x.get('date')!=date:raise ValueError('Cached date mismatch')
    return day,url,x,hashlib.sha256(raw).hexdigest()
def assemble(rows,pool_size=40):
    points,names,pools,calendar,provenance,benchmark=[],{}, {},[],[],[]
    prior=[];prior_day=None;previous_close={}
    clean=lambda x:re.sub('<[^>]+>','',str(x)).replace(',','').strip()
    for day,url,x,digest in rows:
        table=next((t for t in x.get('tables',[]) if '證券代號' in t.get('fields',[])),None)
        is_open=bool(table and table.get('data'))
        calendar.append(dict(day=day,open=is_open,source=url,verified_at=dt.datetime.now(dt.timezone.utc).isoformat()))
        provenance.append(dict(day=day,url=url,sha256=digest,rows=len(table.get('data',[])) if table else 0))
        if not is_open:continue
        if prior:pools[day]=dict(asof=prior_day,symbols=[p['symbol'] for p in sorted(prior,key=lambda p:float(p['amount_twd']),reverse=True)[:pool_size]])
        session=[]
        for row in table['data']:
            fields=dict(zip(table['fields'],row));symbol=clean(fields['證券代號'])
            if not re.fullmatch('[1-8][0-9]{3}',symbol):continue
            try:
                values=[clean(fields[k]) for k in ['開盤價','最高價','最低價','收盤價']]
                if not all(float(p)>0 for p in values):continue
                p=dict(symbol=symbol,at=day+'T13:30:00+08:00',open=values[0],high=values[1],low=values[2],close=values[3],
                    volume_shares=int(clean(fields['成交股數'])),amount_twd=clean(fields['成交金額']))
                # A known discontinuity is left in history, but cannot produce assumed executable quotes.
                if symbol in previous_close and not .9<=float(p['open'])/previous_close[symbol]<=1.1:p['corporate_action']=True
                previous_close[symbol]=float(p['close']);session.append(p)
                names[symbol]=dict(name=clean(fields['證券名稱']),exchange='TSE')
            except (ValueError,KeyError):continue
        for t in x.get('tables',[]):
            for row in t.get('data',[]):
                if row and clean(row[0])=='發行量加權股價指數':
                    benchmark.append(dict(day=day,close=clean(row[1]),source=url));break
            if benchmark and benchmark[-1]['day']==day:break
        points.extend(session);prior=session;prior_day=day
    return dict(source='https://www.twse.com.tw/exchangeReport/MI_INDEX dated ALLBUT0999 cross sections',synthetic=False,frequency='DAILY',
        points=points,names=names,daily_universe=pools,calendar=calendar,limitations=[
            'TWSE only; no OTC. Four-digit identifier is a proxy, not a fully verified historical security master.',
            'Prior-session turnover universe avoids using a fixed present-day surviving stock list; historical suspensions/attention/disposition remain incomplete.',
            'Unadjusted prices; cash dividends, splits and company actions are not a total-return series.',
            'Daily open/close and prior-volume participation are approximations, not actual minute/odd-lot executions.',
            'No measured real odd-lot liquidity or auction queues; performance is research evidence, not live validation.']),provenance,benchmark

def main():
    a=argparse.ArgumentParser(description=__doc__);a.add_argument('--start',required=True);a.add_argument('--end',required=True);a.add_argument('--output',type=pathlib.Path,required=True);a.add_argument('--cache',type=pathlib.Path,required=True);args=a.parse_args()
    args.cache.mkdir(parents=True,exist_ok=True);start,end=dt.date.fromisoformat(args.start),dt.date.fromisoformat(args.end)
    if start>end:raise ValueError('Date range')
    days=[(start+dt.timedelta(days=n)).isoformat() for n in range((end-start).days+1) if (start+dt.timedelta(days=n)).weekday()<5]
    rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for result in pool.map(retrieve,[(d,args.cache) for d in days]):
            rows.append(result)
            if len(rows)%25==0:print('Downloaded',len(rows),'/',len(days),flush=True)
    dataset,provenance,benchmark=assemble(rows)
    # Include known weekend closures so T+2 cannot silently assume missing calendar days.
    known={s['day'] for s in dataset['calendar']}
    for n in range((end-start).days+1):
        date=start+dt.timedelta(days=n)
        if date.isoformat() not in known:dataset['calendar'].append(dict(day=date.isoformat(),open=False,source='Weekend',verified_at=dt.datetime.now(dt.timezone.utc).isoformat()))
    # Annual exchange/settlement calendar is independent of missing price rows.
    verified_calendar=[];calendar_sources=[]
    closures_path=pathlib.Path(__file__).parents[1]/'validation'/'calendar-closures.json'
    closures={r['day']:r for r in json.loads(closures_path.read_text())} if closures_path.exists() else {}
    for year in range(start.year,end.year+1):
        url=f'https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date={year}0101'
        path=args.cache/(f'calendar-{year}.json')
        if not path.exists():path.write_bytes(urllib.request.urlopen(url,timeout=30).read())
        raw_calendar=path.read_bytes();annual=json.loads(raw_calendar)
        if str(year-1911) not in annual.get('title','') or annual.get('fields')!=['日期','名稱','說明']:raise ValueError('Calendar year/schema mismatch')
        closed={r[0] for r in annual['data'] if '開始交易日' not in r[1] and '最後交易日' not in r[1]}
        only={r[0] for r in annual['data'] if '僅辦理結算交割' in r[1]}
        for n in range((dt.date(year+1,1,1)-dt.date(year,1,1)).days):
            date=dt.date(year,1,1)+dt.timedelta(days=n);day=date.isoformat()
            base=date.weekday()<5 and day not in closed
            r=dict(day=day,open=base,settlement_open=base or day in only,source=url,verified_at=dt.datetime.now(dt.timezone.utc).isoformat())
            if day in closures:r.update(open=False,settlement_open=False,known_at=closures[day]['known_at'],scheduled_open=base,scheduled_settlement_open=base or day in only,source=closures[day]['source'])
            verified_calendar.append(r)
        calendar_sources.append(dict(year=year,url=url,sha256=hashlib.sha256(raw_calendar).hexdigest()))
    dataset['calendar']=verified_calendar
    calendar_sources.append(dict(file='validation/calendar-closures.json',sha256=hashlib.sha256(closures_path.read_bytes()).hexdigest(),note='Dated announcement evidence; visibility is conservative midnight on the closure day, exact prior-evening minute unavailable.'))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    raw=json.dumps(dataset,ensure_ascii=False,separators=(',',':')).encode();args.output.write_bytes(gzip.compress(raw,mtime=0))
    args.output.with_suffix('.provenance.json').write_text(json.dumps(dict(retrieved_at=dt.datetime.now(dt.timezone.utc).isoformat(),dataset_sha256=hashlib.sha256(raw).hexdigest(),sources=provenance,calendar_sources=calendar_sources,benchmark=benchmark),ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(dict(points=len(dataset['points']),sessions=len(dataset['daily_universe']),symbols=len(dataset['names']),sha256=hashlib.sha256(raw).hexdigest())))
if __name__=='__main__':main()
