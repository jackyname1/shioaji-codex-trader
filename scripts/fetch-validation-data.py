"""Download public, unadjusted TWSE daily bars. Never convert daily bars into claimed minute history."""
import concurrent.futures
import datetime as dt
import hashlib
import json
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'validation-market-data'
SYMBOLS = ['2330', '2303', '2317', '2454', '2308', '2881', '2882', '2603', '2002', '1216']
MONTHS = [f'{y}{m:02d}01' for y in [2025, 2026] for m in range(1, 13) if f'{y}{m:02d}' <= '202610']


def read_one(item):
    symbol, month = item
    path = OUT / 'raw' / f'{symbol}-{month}.json'
    url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}&stockNo={symbol}'
    if not path.exists():
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=20) as response:
                    raw = response.read()
                obj = json.loads(raw)
                if obj.get('stat') != 'OK' or not obj.get('data'):
                    raise ValueError('TWSE did not return daily bars')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                time.sleep(.5)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
    raw = path.read_bytes()
    return symbol, month, url, json.loads(raw), hashlib.sha256(raw).hexdigest()


if __name__ == '__main__':
    points, provenance = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        for symbol, month, url, obj, digest in executor.map(read_one, [(s, m) for s in SYMBOLS for m in MONTHS]):
            provenance.append({'symbol': symbol, 'month': month, 'url': url, 'sha256': digest})
            for row in obj['data']:
                y, m, day = map(int, row[0].split('/'))
                date = dt.date(y + 1911, m, day).isoformat()
                if date > '2026-10-15':
                    continue
                clean = lambda x: str(x).replace(',', '')
                try:
                    values = [clean(row[i]) for i in [3, 4, 5, 6]]
                    if not all(float(x) > 0 for x in values):
                        continue
                    points.append(dict(symbol=symbol, at=date+'T13:30:00+08:00', open=values[0], high=values[1], low=values[2],
                                       close=values[3], volume_shares=int(clean(row[1])), amount_twd=clean(row[2])))
                except ValueError:
                    continue
    dataset = dict(source='TWSE STOCK_DAY public daily OHLCV; fixed prespecified 10-stock pool', synthetic=False, frequency='DAILY',
                   points=points, names={}, limitations=['Unadjusted daily prices; dividend/split, delisting and survivorship biases remain.',
                   'Daily open/close execution approximation cannot validate intraday rebound, trailing paths, auction queue or odd-lot fills.',
                   'Observed session dates are not a verified future settlement calendar; unavailable T+2 credits remain reserved.'])
    OUT.mkdir(exist_ok=True)
    (OUT / 'twse-daily.json').write_text(json.dumps(dataset, ensure_ascii=False))
    (OUT / 'provenance.json').write_text(json.dumps({'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'sources': provenance}, indent=2))
    print(json.dumps({'points': len(points), 'sources': len(provenance), 'dataset': str(OUT / 'twse-daily.json')}), flush=True)
