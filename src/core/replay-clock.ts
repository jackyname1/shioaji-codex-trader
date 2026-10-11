import { setTimeout as delay } from 'node:timers/promises';
import { twDay } from './models.js';

export type ReplayCommand = 'pause' | 'resume' | 'step';
/** Playback pacing never changes market timestamps, fills or strategy scheduling. */
export class ReplayClock {
  paused = false;
  speed = 0;
  private steps = 0;
  private previous = 0;
  private waiting=false;
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
    if(this.waiting)throw new Error('回測上一個時間事件仍在等待');
    const next=Date.parse(at);if(!Number.isFinite(next))throw new Error('回測事件時間不合法');
    this.waiting=true;
    try{signal.throwIfAborted();
      // Nights and holidays contain no simulated market steps. Intraday speed keeps its stated ratio.
      let remaining=this.previous&&twDay(new Date(next))===twDay(new Date(this.previous))?Math.max(0,next-this.previous):0;
      for(;;){
        while(this.paused&&!this.steps){await new Promise<void>((resolve,reject)=>{
          const clean=():void=>{signal.removeEventListener('abort',abort);this.wake=undefined;};
          const done=():void=>{clean();resolve();},abort=():void=>{clean();reject(new Error('回測已停止'));};
          this.wake=done;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });signal.throwIfAborted();}
        if(this.paused&&this.steps){this.steps--;break;}
        if(!remaining||!this.speed)break;
        const speed=this.speed,wait=Math.min(100,remaining/speed);
        await delay(wait,undefined,{signal});remaining=Math.max(0,remaining-wait*speed);
      }
      signal.throwIfAborted();this.previous=next;
    }finally{this.waiting=false;}
  }
}
