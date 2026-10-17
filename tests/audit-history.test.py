import importlib.util,json,pathlib,tempfile,unittest
path=pathlib.Path(__file__).parents[1]/'scripts'/'audit-execution-history.py'
spec=importlib.util.spec_from_file_location('audit',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
D=module.D
def snapshot(at,equity='1000',review=False):
    return dict(at=at,asof=at,stage='SNAPSHOT',message='',details=dict(asof=at,universe=[],review_only=review,hard_limits={},account=dict(equity=equity,positions=[])))
def event(at,stage,msg):return dict(at=at,asof=at,stage=stage,message=msg)
def document():
    return dict(version='0.2.4',events=[snapshot('2026-01-02T01:00:00Z'),
      event('2026-01-02T01:01:00Z','FILL','9001 BUY 10 股 @ 10 · 手續費 20 · 稅 0'),
      event('2026-01-05T01:00:00Z','FILL','9001 SELL 5 股 @ 20 · 手續費 20 · 稅 1'),
      event('2026-01-05T01:01:00Z','FILL','9001 BUY 5 股 @ 15 · 手續費 20 · 稅 0'),
      event('2026-01-06T01:00:00Z','FILL','9001 SELL 10 股 @ 25 · 手續費 20 · 稅 1'),snapshot('2026-01-06T06:00:00Z','1093',True)])
class AuditTests(unittest.TestCase):
 def test_fifo_partial_and_adds(self):
    r=module.audit(document());self.assertEqual(r['summary']['realized_net_pnl'],D(93));self.assertEqual(len(r['trades']),1)
    self.assertEqual(r['trades'][0]['total_costs'],D(82));self.assertEqual(r['summary']['expectancy'],D(93))
 def test_incomplete_opening_inventory_fails(self):
    x=document();del x['events'][1]
    with self.assertRaisesRegex(ValueError,'inventory'):module.audit(x)
 def test_malformed_fill_fails(self):
    x=document();x['events'][1]['message']='bad fill'
    with self.assertRaisesRegex(ValueError,'Unrecognized'):module.audit(x)
 def test_future_event_reordering_fails(self):
    x=document();x['events'][1],x['events'][2]=x['events'][2],x['events'][1]
    with self.assertRaisesRegex(ValueError,'monotone'):module.audit(x)
 def test_asof_not_wall_clock_and_close_vs_intraday(self):
    x=document();x['events'][1]['at']='2030-01-01T00:00:00Z';x['events'].insert(1,snapshot('2026-01-02T01:00:30Z','1200'))
    r=module.audit(x);self.assertEqual(r['summary']['observed_snapshots']['peak'],D(1200));self.assertEqual(r['summary']['postmarket']['peak'],D(1093))
 def test_complete_exports(self):
    with tempfile.TemporaryDirectory() as tmp:
      module.write_outputs(module.audit(document()),pathlib.Path(tmp))
      self.assertEqual(len((pathlib.Path(tmp)/'events.jsonl').read_text().splitlines()),6)
      self.assertEqual(len((pathlib.Path(tmp)/'fills.csv').read_text(encoding='utf-8-sig').splitlines()),5)
if __name__=='__main__':unittest.main()
