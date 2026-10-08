import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from shioaji_trader.codex import CodexRunner, output_schema
from shioaji_trader.models import Order, Quote, Settings, TAIPEI
from shioaji_trader.service import Service, make_engine
from shioaji_trader.storage import Store
from shioaji_trader.strategy import demo_plan


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/'state.db')
        self.now = datetime(2026,10,8,10,tzinfo=TAIPEI)
        self.settings = Settings(auto_execute=True, minimum_fee=1)
        self.engine = make_engine(self.store,self.settings)
        self.engine.start(self.now)
        self.snapshot = self.engine.snapshot(self.now)
        self.analysis = demo_plan(self.snapshot,self.settings,self.now).analysis

    def tearDown(self):
        self.engine.close()
        self.store.close()
        self.tmp.cleanup()

    def test_partial_fill_cancel_preserves_inventory(self):
        broker = self.engine.broker
        order = Order(local_id='partial',symbol='9001',action='BUY',shares=25,
                      limit_price=45,created_at=self.now,plan_id='test')
        accepted = broker.submit(order)
        quote = Quote(symbol='9001',last=45,bid='44.95',ask=45,
                      trade_at=self.now+timedelta(seconds=1),book_at=self.now,
                      ask_shares=7,bid_shares=7)
        broker.match(quote,self.now+timedelta(seconds=1))
        current = broker.reconcile([accepted])[0]
        self.assertEqual((current.status,current.filled),('PARTIAL',7))
        broker.match(quote,self.now+timedelta(seconds=1))
        self.assertEqual(broker.reconcile([current])[0].filled,7)
        cancelled = broker.cancel(current)
        self.assertEqual((cancelled.status,cancelled.filled),('CANCELLED',7))
        self.assertEqual(broker.account(self.now).positions[0].shares,7)

    def test_codex_command_schema_env_and_output(self):
        expected = self.analysis.model_dump_json()
        captured = {}
        class Process:
            returncode = 0
            def __init__(self, command, **options):
                captured.update(options)
                captured['command'] = command
                Path(command[command.index('--output-last-message')+1]).write_text(expected,encoding='utf-8')
            def communicate(self, prompt=None, timeout=None):
                captured['prompt'] = prompt
                return ('{"type":"turn.completed","usage":{"input_tokens":100}}', '')
        with patch('shioaji_trader.codex.executable_command',return_value=['fake-codex']), \
             patch('shioaji_trader.codex.subprocess.Popen',Process), \
             patch.dict(os.environ,{'SJ_API_KEY':'do-not-forward','LIVE_TRADING':'true'}):
            result = CodexRunner().analyze(self.snapshot,self.settings)
        self.assertEqual(result.snapshot_id,self.snapshot['snapshot_id'])
        self.assertNotIn('SJ_API_KEY',captured['env'])
        self.assertNotIn('LIVE_TRADING',captured['env'])
        self.assertIn('--output-schema',captured['command'])
        self.assertIn('read-only',captured['command'])
        self.assertNotIn('do-not-forward',captured['prompt'])
        self.assertFalse(output_schema()['additionalProperties'])

    def test_codex_overlapping_job_rejected(self):
        runner = CodexRunner()
        runner.lock.acquire()
        try:
            with self.assertRaises(RuntimeError):
                runner.analyze(self.snapshot,self.settings)
        finally:
            runner.lock.release()

    def test_review_demo_does_not_generate_buy(self):
        service = Service(self.store)
        snapshot = dict(self.snapshot,review_only=True)
        with patch('shioaji_trader.service.now_tw',return_value=self.now):
            service._analyze(snapshot,self.settings)
        command, (analysis, _) = service.commands.get_nowait()
        self.assertEqual(command,'analysis_ready')
        self.assertEqual(analysis.stance,'HOLD_ONLY')
        self.assertEqual(analysis.decisions,[])

    def test_plan_expiry_cancels_unfilled_entry(self):
        self.engine.activate(self.analysis,self.snapshot,self.now)
        order = Order(local_id='expire',symbol='9001',action='BUY',shares=10,
                      limit_price=40,created_at=self.now,plan_id=self.engine.plan.id)
        pending = self.engine.broker.submit(order)
        self.store.save_order(pending)
        self.engine.tick(self.analysis.expires_at+timedelta(seconds=1))
        self.assertEqual(self.store.orders()[0].status,'CANCELLED')


if __name__ == '__main__':
    unittest.main()
