"""Verify and archive the completed simulation reports, without account records."""
from collections import Counter, defaultdict
from decimal import Decimal as D
import gzip
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1] / 'validation'
comparison = json.loads((root / 'comparison.json').read_text())
assert comparison['status'] == 'COMPLETED'
assert comparison['completed_cases'] == comparison['expected_cases'] == 17
manifest = {'dataset_sha256': comparison['dataset_sha256'], 'cases': []}
members = []
for case in comparison['results']:
    descriptor = case['execution_audit']
    name = descriptor['file']
    assert Path(name).name == name and name.endswith('.json.gz')
    data = (root / 'run-audits' / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == descriptor['sha256'], name
    report = json.loads(gzip.decompress(data))
    assert report['status'] == case['status'] == 'COMPLETED', name
    assert report['metrics'] == case['metrics'], name
    assert not report['failures'], name
    orders = {order['local_id']: order for order in report['orders']}
    submitted = {event['order_id'] for event in report['workflow']
                 if event['stage'] == 'SUBMISSION' and event.get('order_id')}
    triggered = {event['order_id'] for event in report['workflow']
                 if event['stage'] == 'TRIGGER' and event.get('order_id')}
    inventory = defaultdict(list)
    amounts = Counter()
    for fill in report['fills']:
        order = orders[fill['order_id']]
        assert fill['at'] > order['created_at'], (name, 'same-event fill')
        assert order['local_id'] in submitted & triggered, (name, 'missing audit chain')
        price, limit = D(fill['price']), D(order['limit_price'])
        assert price <= limit if fill['action'] == 'BUY' else price >= limit, (name, 'limit')
        assert fill['shares'] > 0
        assert abs(price * fill['shares'] - D(fill['amount'])) < D('0.000001')
        amounts['fees'] += D(fill['fee'])
        amounts['taxes'] += D(fill['tax'])
        if fill['action'] == 'BUY':
            inventory[fill['symbol']].append([fill['at'][:10], fill['shares']])
        else:
            needed = fill['shares']
            for lot in inventory[fill['symbol']]:
                # These fixtures use Taiwan morning events, whose UTC and local dates agree.
                if lot[0] >= fill['at'][:10]:
                    continue
                used = min(needed, lot[1])
                needed -= used
                lot[1] -= used
            assert needed == 0, (name, 'sale exceeds prior-day inventory')
    metrics = report['metrics']
    assert len(report['fills']) == metrics['fill_count']
    assert all(amounts[key] == D(metrics[key]) for key in ['fees', 'taxes'])
    assert abs(D(metrics['realized_pnl']) + D(metrics['unrealized_pnl']) - D(metrics['net_pnl'])) <= D('0.01')
    assert D(metrics['final_equity']) - D(metrics['initial_cash']) == D(metrics['net_pnl'])
    manifest['cases'].append({'period': case['period'], 'variant': case['variant'],
                             **descriptor, 'fills': len(report['fills']),
                             'orders': len(orders), 'workflow_events': len(report['workflow'])})
    members.append((name, data))
manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
(root / 'execution-audit-manifest.json').write_bytes(manifest_bytes)
members.append(('manifest.json', manifest_bytes))
with ZipFile(root / 'run-audits.zip', 'w', compression=ZIP_STORED) as archive:
    for name, data in sorted(members):
        info = ZipInfo(name, date_time=(2026, 10, 16, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(f'Verified {len(manifest["cases"])} complete reports: fills, costs, limits, prior-day inventory, triggers and submissions')
print('Archive SHA256:', hashlib.sha256((root / 'run-audits.zip').read_bytes()).hexdigest())
