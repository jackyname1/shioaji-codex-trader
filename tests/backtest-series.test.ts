import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backtestSeries} from '../src/core/backtest-series.js';
import type {BacktestReport} from '../src/core/backtest.js';
test('drawdown uses every observed mark before chart downsampling and costs come from raw fills',()=>{
 const r={request:{initial_cash:'100000'},timeline:[{at:'a',equity:'105000',cash:'80000',exposure_pct:'23.8095'},
 {at:'b',equity:'99000',cash:'80000',exposure_pct:'19.1919'},{at:'c',equity:'103000',cash:'80000',exposure_pct:'22.3301'}],
 fills:[{at:'a',fee:'20',tax:'0'},{at:'b',fee:'0',tax:'15'}],daily_equity:[]} as unknown as BacktestReport;
 const s=backtestSeries(r);assert.equal(s.drawdown[1]!.equity,'-5.7143');assert.equal(s.costs[1]!.equity,'35');assert.equal(s.exposure[2]!.equity,'22.3301');
 delete r.timeline![0]!.exposure_pct;assert.equal(backtestSeries(r).exposure.length,2);
});
