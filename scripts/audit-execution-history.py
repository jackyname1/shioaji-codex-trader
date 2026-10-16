"""Reconcile an exported execution history, without treating sparse snapshots as complete market data."""
import collections
import decimal
import hashlib
import json
import pathlib
import re
import sys

D = decimal.Decimal
source = pathlib.Path(sys.argv[1])
events = json.loads(source.read_text())['events']
snapshots = [e['details'] for e in events if e['stage'] == 'SNAPSHOT' and isinstance(e.get('details'), dict) and 'account' in e['details']]
full = [s for s in snapshots if 'universe' in s]
lots, exits, fills = collections.defaultdict(list), [], []
for e in events:
    if e['stage'] != 'FILL':
        continue
    m = re.fullmatch(r'(\d+) (BUY|SELL) (\d+) 股 @ ([\d.]+) · 手續費 ([\d.]+) · 稅 ([\d.]+)', e['message'])
    if not m:
        raise ValueError('Unrecognized fill record')
    symbol, action, shares, price, fee, tax = m.groups()
    n, price, fee, tax = int(shares), D(price), D(fee), D(tax)
    f = dict(at=e['asof'], symbol=symbol, action=action, shares=n, price=str(price), fee=str(fee), tax=str(tax))
    if action == 'BUY':
        lots[symbol].append([n, price * n + fee])
    else:
        needed, basis = n, D(0)
        for lot in lots[symbol]:
            used = min(needed, lot[0])
            if not used:
                continue
            cost = lot[1] * used / lot[0]
            lot[0] -= used; lot[1] -= cost; needed -= used; basis += cost
        assert needed == 0
        f['net_pnl'] = str(price * n - fee - tax - basis)
        exits.append(f)
    fills.append(f)
realized = sum((D(f['net_pnl']) for f in exits), D(0))
last = full[-1]['account']; final = D(last['equity']); initial = D(full[0]['account']['equity'])
wins = [D(f['net_pnl']) for f in exits if D(f['net_pnl']) > 0]
losses = [-D(f['net_pnl']) for f in exits if D(f['net_pnl']) < 0]
post = {s['asof'][:10]: s for s in full if s.get('review_only')}
exposure = lambda s: sum((D(p['last_price']) * p['shares'] for p in s['account']['positions']), D(0)) / D(s['account']['equity']) * 100
peak, drawdown = initial, D(0)
for s in snapshots:
    e = D(s['account']['equity']); peak = max(peak, e); drawdown = max(drawdown, (peak-e)/peak*100)
buy_decisions, trailing = 0, 0
entry_types=collections.Counter();all_trailing=0
failures = [dict(asof=e['asof'], message=e['message']) for e in events if e['stage'] == 'FAILED']
failure_details = []
for event in events:
    if event['stage'] != 'OUTPUT':
        continue
    try:
        a = json.loads(event['message'])
    except ValueError:
        continue
    ds = a.get('decisions', [])
    buy_decisions += sum(d['action'] == 'BUY' for d in ds)
    entry_types.update(d['entry_when'] for d in ds if d['action']=='BUY')
    all_trailing += sum(bool(d.get('smart') and d['smart'].get('trailing_activate') is not None) for d in ds)
    trailing += sum(d['action'] == 'BUY' and d.get('smart') and d['smart'].get('trailing_activate') is not None for d in ds)
    if any(f['asof'] == event['asof'] for f in failures):
        s = next((s for s in full if s['snapshot_id'] == a.get('snapshot_id')), None)
        if s:
            pool = {c['symbol'] for c in s['universe']}; held = {p['symbol'] for p in s['account']['positions']}
            outside = set(a.get('candidates', [])) - pool
            if outside:
                failure_details.append(dict(asof=event['asof'], outside=sorted(outside), held_outside=sorted(outside & held)))
result = dict(source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), events=len(events), initial_cash=str(initial),
    final_equity=str(final), return_pct=str((final/initial-1)*100), realized_net_pnl=str(realized), unrealized_after_buy_fees=str(final-initial-realized),
    fills=len(fills), exits=len(exits), fees=str(sum((D(f['fee']) for f in fills),D(0))), taxes=str(sum((D(f['tax']) for f in fills),D(0))),
    win_rate_pct=str(D(len(wins))/len(exits)*100), average_win=str(sum(wins)/len(wins)), average_loss=str(sum(losses)/len(losses)),
    profit_factor=str(sum(wins)/sum(losses)), average_close_exposure_pct=str(sum(exposure(s) for s in post.values())/len(post)),
    close_exposure_days=len(post), final_exposure_pct=str(exposure(full[-1])), snapshot_peak_equity=str(peak), snapshot_max_drawdown_lower_bound_pct=str(drawdown),
    buy_proposals=buy_decisions, buy_proposals_with_trailing=trailing, failures=failures, failure_details=failure_details,
    entry_types=dict(entry_types),all_decisions_with_trailing=all_trailing,
    logged_risk_events=sum(e['stage']=='RISK' for e in events),
    distinct_logged_risk_messages=len({e['message'] for e in events if e['stage']=='RISK'}),
    october15_exits_net=sum((D(f['net_pnl']) for f in exits if f['at'].startswith('2026-10-15')),D(0)),
    limitations=['Execution log contains snapshots, not a complete minute path. Intraday max drawdown and unfilled-signal distribution are not recoverable.',
    'Close exposure uses one review snapshot per session. Unrealized PnL includes paid buy fees; future liquidation fees and tax are excluded.'])
print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
