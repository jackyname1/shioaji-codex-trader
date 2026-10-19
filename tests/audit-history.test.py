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
 def test_unvalidated_model_output_cannot_change_the_recorded_stop(self):
    x=document();x['events'][0]['details']['existing_protection']={'9001':{'stop_price':'9'}}
    x['events'].insert(1,event('2026-01-02T01:00:10Z','OUTPUT',json.dumps({'decisions':[{'symbol':'9001','smart':{'stop_price':'999'}}]})))
    x['events'].insert(3,event('2026-01-05T00:59:00Z','TRIGGER','9001 SELL：STOP'))
    r=module.audit(x);self.assertEqual(r['fills'][1]['stop_price'],'9')
 def test_exact_trigger_context_and_fill_identity_survive(self):
    x=document();t=event('2026-01-05T00:59:00Z','TRIGGER','9001 SELL：STOP');t['details']={'order':{'trigger_context':{'stop_price':'8','effective_stop':'8'}}};x['events'].insert(2,t)
    x['events'][3]['details']={'fill':{'id':'fill-id'},'order_id':'order-id'}
    r=module.audit(x);self.assertEqual(r['fills'][1]['stop_source'],'EXACT_TRIGGER_CONTEXT');self.assertEqual(r['fills'][1]['id'],'fill-id');self.assertEqual(r['fills'][1]['order_id'],'order-id')
 def test_structured_fill_must_agree_with_display_message(self):
    x=document();x['events'][1]['details']={'fill':{'id':'f','symbol':'9001','action':'BUY','shares':11,'price':'10','fee':'20','tax':'0'}}
    with self.assertRaisesRegex(ValueError,'disagrees'):module.audit(x)
 def test_duplicate_fill_identity_cannot_double_count_inventory(self):
    x=document();e=x['events'][1];e['details']={'fill':{'id':'f'}};x['events'].insert(2,dict(e))
    with self.assertRaisesRegex(ValueError,'Duplicate'):module.audit(x)
if __name__=='__main__':unittest.main()
