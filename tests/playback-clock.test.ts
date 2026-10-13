import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayClock,type ReplayClockState} from '../src/core/replay-clock.js';
import {BacktestRequestSchema} from '../src/core/backtest.js';
import {replayDisplayTime} from '../src/desktop/replay-time.js';

const start='2026-01-05T01:10:00.000Z',at=(seconds:number)=>new Date(Date.parse(start)+seconds*1000).toISOString();
test('accelerated pacing advances seconds at the selected ratio and freezes between events',async()=>{
  let wall=0;const states:ReplayClockState[]=[];
  const clock=new ReplayClock(s=>states.push(s),{now:()=>wall,wait:async(ms)=>{wall+=ms;}});
  clock.setSpeed(10);await clock.before(start,new AbortController().signal);
  await clock.before(at(30),new AbortController().signal,false);
  assert.equal(wall,3000);assert.ok(states.some(s=>Date.parse(s.at)>Date.parse(start)&&Date.parse(s.at)<Date.parse(at(30))&&s.advancing));
  assert.equal(clock.snapshot().advancing,false);wall+=30000;assert.equal(clock.snapshot().at,at(30),'Analysis time must not advance replay');
  clock.setSpeed(0);await clock.before(at(300),new AbortController().signal);
  assert.equal(clock.snapshot().at,at(300));assert.equal(wall,33000,'Direct mode must not wait for simulated seconds');
});
test('both IPC clock and saved requests reject excessive speed and separate direct zero from 1–60 acceleration',()=>{
  const clock=new ReplayClock();for(const speed of [0,1,10,60]){clock.setSpeed(speed);assert.equal(clock.speed,speed);assert.equal(BacktestRequestSchema.parse({start:'2026-01-05',end:'2026-01-05',playback_speed:speed}).playback_speed,speed);}
  for(const speed of [-1,.5,61,100000,NaN,Infinity]){assert.throws(()=>clock.setSpeed(speed));assert.throws(()=>BacktestRequestSchema.parse({start:'2026-01-05',end:'2026-01-05',playback_speed:speed}));}
});
test('pause and a speed change settle elapsed time once, without catching up paused wall time',async()=>{
  let wall=0,release!:()=>void;const clock=new ReplayClock(undefined,{now:()=>wall,wait:()=>new Promise<void>(resolve=>{release=resolve;})});
  const signal=new AbortController().signal;clock.setSpeed(10);await clock.before(start,signal);
  const waiting=clock.before(at(10),signal);wall=100;assert.equal(clock.snapshot().at,at(1));clock.command('pause');wall=5100;
  assert.equal(clock.snapshot().at,at(1));clock.setSpeed(20);assert.equal(clock.snapshot().at,at(1));clock.command('resume');release();
  await new Promise<void>(resolve=>setImmediate(resolve));wall+=100;assert.equal(clock.snapshot().at,at(3));
  clock.setSpeed(0);release();await waiting;assert.equal(clock.snapshot().at,at(10));
});
test('renderer seconds interpolate only a clock label, stop at the next event, and freeze immediately for Codex',()=>{
  const state:ReplayClockState={at:start,next_at:at(30),advancing:true,speed:10,sampled_at:1000};
  assert.equal(replayDisplayTime(state,2000),at(10));assert.equal(replayDisplayTime(state,999),start);
  assert.equal(replayDisplayTime(state,999999),at(30));assert.equal(replayDisplayTime({...state,advancing:false},5000),start);
  assert.equal(replayDisplayTime({...state,speed:0},5000),start);
});
