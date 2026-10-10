import { setTimeout as delay } from 'node:timers/promises';

export type ReplayCommand = 'pause' | 'resume' | 'step';
/** Playback pacing never changes market timestamps, fills or strategy scheduling. */
export class ReplayClock {
  paused = false;
  speed = 0;
  private steps = 0;
  private previous = 0;
  private wake?: () => void;
  command(command: ReplayCommand): void {
    if (command === 'pause') this.paused = true;
    if (command === 'resume') { this.paused = false; this.steps = 0; }
    if (command === 'step') { this.paused = true; this.steps++; }
    this.wake?.();
  }
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0 || speed > 100000) throw new Error('回測速度不合法');
    this.speed = speed; this.wake?.();
  }
  async before(at: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    while (this.paused && !this.steps) {
      await new Promise<void>((resolve, reject) => {
        const done = (): void => { signal.removeEventListener('abort', abort); this.wake = undefined; resolve(); };
        const abort = (): void => { this.wake = undefined; reject(new Error('回測已停止')); };
        this.wake = done; signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    }
    const stepped = this.paused && this.steps > 0;
    if (stepped) this.steps--;
    const next = Date.parse(at), gap = this.previous ? Math.min(60000, Math.max(0, next - this.previous)) : 0;
    this.previous = next;
    // Overnight/holiday gaps are compressed; no price interpolation is performed.
    let virtualRemaining = gap;
    while (!stepped && !this.paused && this.speed > 0 && virtualRemaining > 0) {
      const speed = this.speed, wait = Math.min(100, virtualRemaining / speed);
      await delay(wait, undefined, { signal }); virtualRemaining -= wait * speed;
    }
    if (this.paused && !stepped) await this.before(at, signal);
    signal.throwIfAborted();
  }
}
