import type { ReplayClockState } from '../core/replay-clock.js';

/** Interpolate the clock label only. Historical data panes keep their processed-event cutoff. */
export function replayDisplayTime(clock:ReplayClockState,wallNow=Date.now()):string {
  const at=Date.parse(clock.at),target=Date.parse(clock.next_at);
  if(!Number.isFinite(at))return '';
  if(!clock.advancing||!clock.speed||!Number.isFinite(target))return clock.at;
  return new Date(Math.min(target,at+Math.max(0,wallNow-clock.sampled_at)*clock.speed)).toISOString();
}
