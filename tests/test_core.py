import tempfile
import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal as D
from pathlib import Path
from types import SimpleNamespace as NS

from pydantic import ValidationError
from shioaji_trader.models import Account, Instrument, Order, Position, Quote, Settings, SmartSpec, Protection, TAIPEI
from shioaji_trader.storage import Store
from shioaji_trader.calendar import TradingCalendar
from shioaji_trader.calendar_seed import seed
from shioaji_trader.risk import Risk, aligned_price
from shioaji_trader.service import make_engine
from shioaji_trader.strategy import demo_plan
from shioaji_trader.smart import evaluate, update_protection
from shioaji_trader.runtime import RuntimeLock
from shioaji_trader.brokers.shioaji import inventory_sellable


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/'test.db')
        seed(self.store)
        self.now = datetime(2026, 10, 8, 10, tzinfo=TAIPEI)
        self.settings = Settings(auto_execute=True, minimum_fee=1)
        self.account = Account(asof=self.now, cash=100000)
        self.quote = Quote(symbol='9001', last=45, bid='44.95', ask=45,
                           trade_at=self.now, book_at=self.now)
        self.instrument = Instrument(symbol='9001', name='fictional', exchange='TSE',
                                     limit_down=40, limit_up=50, verified_at=self.now)
        self.order = Order(local_id='abc', symbol='9001', action='BUY', shares=10,
                           limit_price=45, created_at=self.now, plan_id='test')

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def verdict(self, **kw):
        values = dict(order=self.order, account=self.account, quote=self.quote,
                      instrument=self.instrument, now=self.now, baseline=D(100000))
        values.update(kw)
        return Risk(self.settings, TradingCalendar(self.store)).check(**values)

    def test_valid_small_odd_buy(self):
        self.assertTrue(self.verdict().allowed)

    def test_missing_or_stale_quote(self):
        self.assertFalse(self.verdict(quote=None).allowed)
        self.quote.book_at -= timedelta(seconds=31)
        self.assertFalse(self.verdict().allowed)

    def test_future_and_simulated_quote(self):
        self.quote.trade_at += timedelta(seconds=1)
        self.assertFalse(self.verdict().allowed)
        self.quote.trade_at = self.now
        self.quote.simulated = True
        self.assertFalse(self.verdict().allowed)

    def test_incomplete_and_stale_account(self):
        self.account.complete = False
        self.assertFalse(self.verdict().allowed)
        self.account.complete = True
        self.account.asof -= timedelta(seconds=61)
        self.assertFalse(self.verdict().allowed)

    def test_whole_lot_and_odd_quantity(self):
        self.order.shares = 1000
        self.assertFalse(self.verdict().allowed)
        self.order.lot = 'COMMON'
        self.assertFalse(self.verdict().allowed)

    def test_today_stock_cannot_sell(self):
        self.order.action = 'SELL'
        self.account.positions = [Position(symbol='9001', shares=20, sellable=0, average_price=45, last_price=45)]
        self.assertFalse(self.verdict().allowed)
        self.account.positions[0].sellable = 10
        self.assertTrue(self.verdict().allowed)

    def test_daily_buy_limit_does_not_block_sell(self):
        self.account.daily_buy_count = 5
        self.assertFalse(self.verdict().allowed)
        self.order.action = 'SELL'
        self.account.positions = [Position(symbol='9001', shares=10, sellable=10, average_price=45, last_price=45)]
        self.assertTrue(self.verdict().allowed)

    def test_pending_and_unknown_orders_block(self):
        other = self.order.model_copy(update={'local_id':'other', 'status':'PENDING'})
        self.account.orders = [other]
        self.assertFalse(self.verdict().allowed)
        other.symbol = '9002'
        other.status = 'UNKNOWN'
        self.assertFalse(self.verdict().allowed)

    def test_settlement_reserve_and_loss(self):
        self.account.settlement_debits = D(99700)
        self.assertFalse(self.verdict().allowed)
        self.account.settlement_debits = D(0)
        self.assertFalse(self.verdict(baseline=D(110000)).allowed)

    def test_live_fee_verification(self):
        self.settings.mode = 'live'
        self.assertFalse(self.verdict().allowed)
        self.settings.fee_verified = True
        self.assertTrue(self.verdict().allowed)

    def test_attention_restriction(self):
        self.instrument.attention = True
        self.assertFalse(self.verdict().allowed)

    def test_price_ticks(self):
        for price in ['9.99','10.05','50.1','100.5','501','1005']:
            self.assertTrue(aligned_price(D(price)))
        for price in ['10.01','50.05','100.1','500.5','1001']:
            self.assertFalse(aligned_price(D(price)))

    def test_calendar_holiday_and_unknown(self):
        cal = TradingCalendar(self.store)
        self.assertFalse(cal.is_open(date(2026,10,9)))
        self.assertEqual(cal.next_session(date(2026,10,8)), date(2026,10,12))
        self.assertFalse(cal.is_open(date(2027,1,4)))
        self.assertFalse(cal.in_session(self.now.replace(hour=13,minute=30)))

    def test_odd_open_effective_date(self):
        cal = TradingCalendar(self.store)
        self.assertFalse(cal.in_session(self.now.replace(hour=9,minute=5)))
        self.assertTrue(cal.in_session(self.now.replace(month=12,day=7,hour=9,minute=5)))

    def test_acquisition_details_and_unit_mismatch(self):
        pos = NS(quantity=20, yd_quantity=10)
        details = [NS(quantity=10, date='2026-10-07', direction='Buy', cond='Cash'),
                   NS(quantity=10, date='2026-10-08', direction='Buy', cond='Cash')]
        self.assertEqual(inventory_sellable(pos, details, self.now.date()),10)
        with self.assertRaises(ValueError):
            inventory_sellable(pos, details[:1], self.now.date())

    def test_trailing_and_nonloosening_update(self):
        spec = SmartSpec(stop_price=40, take_profit=None, trailing_activate=50, trailing_fraction='.05')
        p = Protection(symbol='9001',spec=spec,plan_id='one')
        self.assertEqual(evaluate(p,D(52)),'')
        self.assertEqual(evaluate(p,D(49)),'TRAILING')
        replacement = SmartSpec(stop_price=39,take_profit=None,trailing_activate=None,trailing_fraction=None)
        updated = update_protection(p,'9001',replacement,'two')
        self.assertEqual(updated.spec.stop_price,D(40))
        self.assertEqual(updated.high_water,D(52))
        self.assertEqual(updated.spec.trailing_activate,D(50))

    def test_model_rejects_naive_time_and_bad_fill(self):
        values = self.order.model_dump()
        values['created_at'] = datetime(2026,10,8)
        with self.assertRaises(ValidationError):
            Order.model_validate(values)
        values['created_at'] = self.now
        values['filled'] = 11
        with self.assertRaises(ValidationError):
            Order.model_validate(values)

    def test_durable_unique_intent(self):
        self.assertTrue(self.store.insert_intent(self.order))
        self.assertFalse(self.store.insert_intent(self.order))
        self.assertEqual(len(self.store.orders()),1)

    def test_single_engine_lock(self):
        first, second = RuntimeLock(self.store.path), RuntimeLock(self.store.path)
        first.acquire()
        try:
            with self.assertRaises(RuntimeError):
                second.acquire()
        finally:
            first.release()
        second.acquire()
        second.release()

    def test_demo_buy_restart_and_next_day_inventory(self):
        engine = make_engine(self.store,self.settings)
        engine.start(self.now)
        snapshot = engine.snapshot(self.now)
        engine.activate(demo_plan(snapshot,self.settings,self.now).analysis,snapshot,self.now)
        for i in range(5):
            engine.tick(self.now+timedelta(seconds=i))
        self.assertEqual(len(self.store.orders()),1)
        self.assertEqual(engine.account.positions[0].sellable,0)
        engine.close()
        restarted = make_engine(self.store,self.settings)
        restarted.start(self.now+timedelta(seconds=6))
        self.assertEqual(restarted.account.positions[0].shares,10)
        nextday = datetime(2026,10,12,10,tzinfo=TAIPEI)
        restarted.refresh_account(nextday)
        self.assertEqual(restarted.account.positions[0].sellable,10)
        restarted.close()

    def test_ambiguous_submission_not_retried(self):
        engine = make_engine(self.store,self.settings)
        engine.start(self.now)
        engine.metadata['9001'] = self.instrument
        engine.quote_cache[('9001',True)] = self.quote
        attempts = []
        def timeout(order):
            attempts.append(order.local_id)
            raise TimeoutError()
        engine.broker.submit = timeout
        self.assertFalse(engine.submit(self.order,self.now))
        self.assertEqual(self.store.orders()[0].status,'UNKNOWN')
        self.assertFalse(engine.submit(self.order,self.now))
        self.assertEqual(len(attempts),1)
        engine.close()


if __name__ == '__main__':
    unittest.main()
