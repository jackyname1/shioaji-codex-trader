// A deterministic cost illustration; never connects to a broker or estimates a stock's return.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {SettingsSchema} from '../dist/src/core/models.js';
import {breakEvenExitPrice} from '../dist/src/core/execution-economics.js';
import {roundTripEstimate} from '../dist/src/core/costs.js';
const settings=SettingsSchema.parse({}),path=resolve(process.argv[2]??'validation/v028/execution-cost-study.json');
const report={kind:'DETERMINISTIC_COST_ILLUSTRATION',security:'SYNTHETIC_PRICE_EXAMPLE_NO_SYMBOL',
  inputs:{buy_price:'30.05',target_price:'33',stop_price:'29',current_ceiling:'33',fee_rate:settings.fee_rate,
    minimum_fee:settings.minimum_fee,sell_tax_rate:settings.sell_tax_rate,risk_slippage_fraction:settings.risk_slippage_fraction},
  cases:[1,10,30,100,999,1000,2000].map(shares=>({lot:shares<1000?'IntradayOdd':'Common',
    ...roundTripEstimate(shares,'30.05','33',settings,'29'),estimated_break_even_exit_price:breakEvenExitPrice(shares,'30.05','33',settings)})),
  limitations:['Not empirical strategy/backtest evidence. Targets are hypothetical, not forecasts.',
    'Fee discounts/minimums depend on the actual brokerage agreement; defaults are conservative estimates.',
    'Common and odd-lot books differ. No fill, queue position or overnight gap outcome is assumed.',
    'Break-even is quantity-specific and excludes opportunity cost; actual slippage/fees can be higher.']};
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.cases.map(c=>({shares:c.shares,break_even:c.estimated_break_even_exit_price,net:c.estimated_net_target_gain}))));
