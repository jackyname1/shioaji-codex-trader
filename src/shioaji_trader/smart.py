from __future__ import annotations

from decimal import Decimal

from .models import Protection, SmartSpec


def update_protection(existing: Protection | None, symbol: str,
                      spec: SmartSpec, plan_id: str) -> Protection:
    values = spec.model_dump()
    if existing:
        # Automatic strategy updates cannot loosen an already configured stop.
        values["stop_price"] = max(spec.stop_price, existing.spec.stop_price)
        if spec.trailing_fraction is not None and existing.spec.trailing_fraction is not None:
            values["trailing_fraction"] = min(spec.trailing_fraction,
                                              existing.spec.trailing_fraction)
        # Keep an activated trailing stop activated through later strategy revisions.
        if existing.spec.trailing_activate is not None:
            values["trailing_activate"] = min(spec.trailing_activate or
                                          existing.spec.trailing_activate,
                                          existing.spec.trailing_activate)
            values["trailing_fraction"] = values["trailing_fraction"] or existing.spec.trailing_fraction
        return Protection(symbol=symbol, spec=SmartSpec.model_validate(values), plan_id=plan_id,
                          high_water=existing.high_water, triggered=existing.triggered)
    return Protection(symbol=symbol, spec=SmartSpec.model_validate(values), plan_id=plan_id)


def evaluate(protection: Protection, price: Decimal) -> str:
    protection.high_water = max(protection.high_water, price)
    # Re-evaluate at the next eligible session; a yesterday-only crossing is not a new sell.
    protection.triggered = ""
    spec = protection.spec
    if price <= spec.stop_price:
        protection.triggered = "STOP"
    elif spec.take_profit is not None and price >= spec.take_profit:
        protection.triggered = "TAKE_PROFIT"
    elif (spec.trailing_activate is not None and spec.trailing_fraction is not None
          and protection.high_water >= spec.trailing_activate
          and price <= protection.high_water * (1 - spec.trailing_fraction)):
        protection.triggered = "TRAILING"
    return protection.triggered
