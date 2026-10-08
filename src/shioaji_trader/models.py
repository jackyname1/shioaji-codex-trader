from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TAIPEI = ZoneInfo("Asia/Taipei")
ZERO = Decimal("0")
Money = Annotated[Decimal, Field(allow_inf_nan=False)]
Symbol = Annotated[str, Field(pattern=r"^[0-9A-Z]{4,8}$")]


def now_tw() -> datetime:
    return datetime.now(TAIPEI)


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    @model_validator(mode="after")
    def timestamps_aware(self):
        for name in type(self).model_fields:
            value = getattr(self, name)
            if isinstance(value, datetime) and value.tzinfo is None:
                raise ValueError(f"{name} requires timezone")
        return self


class Instrument(Model):
    symbol: Symbol
    name: str
    exchange: Literal["TSE", "OTC"]
    category: str = ""
    kind: Literal["STOCK", "ETF", "OTHER"] = "STOCK"
    reference: Money = ZERO
    limit_down: Money = ZERO
    limit_up: Money = ZERO
    suspended: bool = False
    disposition: bool = False
    attention: bool = False
    verified_at: datetime


class Quote(Model):
    symbol: Symbol
    last: Annotated[Money, Field(gt=0)]
    bid: Annotated[Money, Field(ge=0)] = ZERO
    ask: Annotated[Money, Field(ge=0)] = ZERO
    trade_at: datetime
    book_at: datetime
    odd: bool = True
    simulated: bool = False
    bid_shares: int = 0
    ask_shares: int = 0

    @field_validator("trade_at", "book_at")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("quote timestamps require a timezone")
        return value


class Position(Model):
    symbol: Symbol
    shares: Annotated[int, Field(ge=0, strict=True)]
    sellable: Annotated[int, Field(ge=0, strict=True)]
    average_price: Annotated[Money, Field(ge=0)]
    last_price: Annotated[Money, Field(ge=0)]

    @model_validator(mode="after")
    def valid_quantity(self):
        if self.sellable > self.shares:
            raise ValueError("sellable exceeds inventory")
        return self


class Order(Model):
    local_id: str
    broker_id: str = ""
    symbol: Symbol
    action: Literal["BUY", "SELL"]
    shares: Annotated[int, Field(gt=0, strict=True)]
    limit_price: Annotated[Money, Field(gt=0)]
    lot: Literal["ODD", "COMMON"] = "ODD"
    status: Literal[
        "PREPARED", "SUBMITTING", "PENDING", "PARTIAL", "FILLED",
        "CANCEL_PENDING", "CANCELLED", "REJECTED", "UNKNOWN"
    ] = "PREPARED"
    filled: Annotated[int, Field(ge=0, strict=True)] = 0
    created_at: datetime
    plan_id: str
    purpose: Literal["ENTRY", "EXIT", "PROTECTION"] = "ENTRY"
    # Broker IDs and the state database stay local, never in Codex inputs or Git.

    @property
    def active(self) -> bool:
        return self.status not in {"FILLED", "CANCELLED", "REJECTED"}

    @property
    def remaining(self) -> int:
        return max(0, self.shares - self.filled)

    @model_validator(mode="after")
    def valid_fill(self):
        if self.filled > self.shares:
            raise ValueError("filled exceeds ordered shares")
        return self


class Account(Model):
    asof: datetime
    cash: Money
    settlement_debits: Annotated[Money, Field(ge=0)] = ZERO
    settlement_credits: Annotated[Money, Field(ge=0)] = ZERO
    positions: list[Position] = Field(default_factory=list)
    orders: list[Order] = Field(default_factory=list)
    complete: bool = True
    issue: str = ""
    daily_buy_amount: Annotated[Money, Field(ge=0)] = ZERO
    daily_buy_count: Annotated[int, Field(ge=0)] = 0

    @property
    def market_value(self) -> Decimal:
        return sum((p.shares * p.last_price for p in self.positions), ZERO)

    @property
    def equity(self) -> Decimal:
        return self.cash - self.settlement_debits + self.settlement_credits + self.market_value

    def position(self, symbol: str) -> Position | None:
        return next((p for p in self.positions if p.symbol == symbol), None)


class SmartSpec(Model):
    stop_price: Annotated[Money, Field(gt=0)]
    take_profit: Annotated[Money, Field(gt=0)] | None
    trailing_activate: Annotated[Money, Field(gt=0)] | None
    trailing_fraction: Annotated[Money, Field(gt=0, lt=1)] | None

    @model_validator(mode="after")
    def valid_prices(self):
        if self.take_profit is not None and self.take_profit <= self.stop_price:
            raise ValueError("take profit must exceed stop price")
        if (self.trailing_activate is None) != (self.trailing_fraction is None):
            raise ValueError("trailing activation and fraction must be supplied together")
        return self


class Decision(Model):
    symbol: Symbol
    action: Literal["BUY", "SELL", "HOLD"]
    shares: Annotated[int, Field(ge=0, le=999000, strict=True)]
    limit_price: Annotated[Money, Field(ge=0)]
    entry_when: Literal["IMMEDIATE", "BELOW", "ABOVE"]
    trigger_price: Annotated[Money, Field(ge=0)]
    smart: SmartSpec | None
    reason: Annotated[str, Field(min_length=1, max_length=1500)]

    @model_validator(mode="after")
    def validate_trade(self):
        if self.action != "HOLD" and (self.shares <= 0 or self.limit_price <= 0):
            raise ValueError("trade needs positive shares and limit price")
        if self.action == "BUY":
            if self.smart is None or self.smart.stop_price >= self.limit_price:
                raise ValueError("BUY needs a stop below entry")
            if self.smart.take_profit is not None and self.smart.take_profit <= self.limit_price:
                raise ValueError("BUY take profit must be above entry")
        if self.entry_when != "IMMEDIATE" and self.trigger_price <= 0:
            raise ValueError("conditional entry needs a trigger")
        return self


class Analysis(Model):
    snapshot_id: str
    expires_at: datetime
    stance: Literal["BUY_ALLOWED", "HOLD_ONLY", "REDUCE"]
    candidates: Annotated[list[Symbol], Field(max_length=20)]
    decisions: Annotated[list[Decision], Field(max_length=40)]
    summary: Annotated[str, Field(min_length=1, max_length=3000)]

    @field_validator("expires_at")
    @classmethod
    def expiry_aware(cls, value):
        if value.tzinfo is None:
            raise ValueError("expiry requires timezone")
        return value

    @model_validator(mode="after")
    def no_duplicates(self):
        if len(self.candidates) != len(set(self.candidates)):
            raise ValueError("duplicate candidates")
        if len({d.symbol for d in self.decisions}) != len(self.decisions):
            raise ValueError("one decision per symbol")
        if self.stance != "BUY_ALLOWED" and any(d.action == "BUY" for d in self.decisions):
            raise ValueError("stance does not allow buys")
        return self


class Plan(Model):
    id: str
    created_at: datetime
    analysis: Analysis


class Protection(Model):
    symbol: Symbol
    spec: SmartSpec
    high_water: Annotated[Money, Field(ge=0)] = ZERO
    triggered: str = ""
    plan_id: str


class Settings(Model):
    mode: Literal["demo", "paper", "readonly", "live"] = "demo"
    auto_execute: bool = False
    whole_lots: bool = False
    min_cash_fraction: Annotated[Money, Field(ge=0, le=1)] = Decimal("0.25")
    max_order_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.10")
    max_symbol_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.20")
    max_exposure_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.75")
    max_daily_buy_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.20")
    max_daily_buy_orders: Annotated[int, Field(ge=1, le=100, strict=True)] = 5
    daily_loss_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.02")
    price_deviation_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.03")
    max_spread_fraction: Annotated[Money, Field(gt=0, le=1)] = Decimal("0.02")
    quote_max_age: Annotated[int, Field(ge=1, le=300, strict=True)] = 30
    account_max_age: Annotated[int, Field(ge=1, le=300, strict=True)] = 60
    cooldown_seconds: Annotated[int, Field(ge=0, le=86400, strict=True)] = 120
    fee_rate: Annotated[Money, Field(ge=0, le=1)] = Decimal("0.001425")
    minimum_fee: Annotated[Money, Field(ge=0)] = Decimal("20")
    sell_tax_rate: Annotated[Money, Field(ge=0, le=1)] = Decimal("0.003")
    fee_verified: bool = False
    settlement_debit_sign: Literal["unverified", "positive", "negative"] = "unverified"
    allow_attention: bool = False
    codex_enabled: bool = False
    official_facts_enabled: bool = True
    codex_path: str = "codex"
    codex_model: str = ""
    codex_reasoning: Literal["default", "low", "medium", "high", "xhigh"] = "default"
    codex_timeout_seconds: Annotated[int, Field(ge=30, le=1800, strict=True)] = 300
    premarket_time: str = "08:40"
    postmarket_time: str = "14:00"
    decision_interval_minutes: Annotated[int, Field(ge=10, le=240, strict=True)] = 60
    plan_max_minutes: Annotated[int, Field(ge=10, le=1440, strict=True)] = 120
    candidate_pool_size: Annotated[int, Field(ge=20, le=100, strict=True)] = 40
    demo_cash: Annotated[Money, Field(gt=0)] = Decimal("100000")
    start_minimized: bool = False
    keep_awake: bool = True

    @field_validator("premarket_time", "postmarket_time")
    @classmethod
    def clock(cls, value):
        datetime.strptime(value, "%H:%M")
        return value

    @model_validator(mode="after")
    def coherent_limits(self):
        if self.max_exposure_fraction + self.min_cash_fraction > 1:
            raise ValueError("cash reserve and exposure limits exceed 100%")
        return self


class SessionDay(Model):
    day: date
    open: bool
    source: str
    verified_at: datetime
