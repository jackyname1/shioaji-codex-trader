import { setTimeout as delay } from 'node:timers/promises';
import { twDay } from './models.js';

export type ReplayCommand = 'pause' | 'resume' | 'step';
export interface ReplayClockState {at:string;next_at:string;advancing:boolean;speed:number;sampled_at:number}
export interface ReplayTiming {now():number;wait(ms:number,signal:AbortSignal):Promise<void>}
const timing:ReplayTiming={now:()=>performance.now(),wait:async(ms,signal)=>{await delay(ms,undefined,{signal});}};
export function validReplaySpeed(speed:number):boolean{return Number.isFinite(speed)&&(speed===0||speed>=1&&speed<=60);}
/** Display pacing cannot change market timestamps, fills or strategy scheduling. */
export class ReplayClock {
  paused=false;speed=0;
  private steps=0;private position=0;private target=0;private advancing=false;
  private anchor=0;private waiting=false;private wake?:()=>void;
  constructor(private readonly onChange?:(state:ReplayClockState)=>void,private readonly time:ReplayTiming=timing){}
  private settle():void {
    const now=this.time.now();
    if(this.advancing)this.position=Math.min(this.target,this.position+Math.max(0,now-this.anchor)*this.speed);
    this.anchor=now;
  }
  snapshot():ReplayClockState {
    this.settle();return {at:this.position?new Date(this.position).toISOString():'',next_at:this.target?new Date(this.target).toISOString():'',
      advancing:this.advancing,speed:this.speed,sampled_at:Date.now()};
  }
  private publish():void {this.onChange?.(this.snapshot());}
  command(command:ReplayCommand):void {
    this.settle();this.advancing=false;
    if(command==='pause')this.paused=true;
    if(command==='resume'){this.paused=false;this.steps=0;}
    if(command==='step'){this.paused=true;this.steps++;}
    this.publish();this.wake?.();
  }
  setSpeed(speed:number):void {
    if(!validReplaySpeed(speed))throw new Error('回測加速限 1–60 倍；0 為直達模式');
    this.settle();this.advancing=false;this.speed=speed;this.publish();this.wake?.();
  }
  async before(at:string,signal:AbortSignal,checkpoint=true):Promise<void> {
    if(this.waiting)throw new Error('回測上一個時間事件仍在等待');
    const next=Date.parse(at);if(!Number.isFinite(next))throw new Error('回測事件時間不合法');
    this.waiting=true;
    try {
      signal.throwIfAborted();
      // Direct mode processes intervening market data without display delays or consuming a step.
      if(!checkpoint&&!this.speed&&!this.paused)return;
      this.settle();this.target=next;this.advancing=false;
      if(!this.position||twDay(new Date(next))!==twDay(new Date(this.position)))this.position=next;
      this.publish();
      for(;;){
        signal.throwIfAborted();
        while(this.paused&&!this.steps){await new Promise<void>((resolve,reject)=>{
          const clean=():void=>{signal.removeEventListener('abort',abort);this.wake=undefined;};
          const done=():void=>{clean();resolve();},abort=():void=>{clean();reject(new Error('回測已停止'));};
          this.wake=done;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });signal.throwIfAborted();}
        if(this.paused&&this.steps){if(checkpoint)this.steps--;this.position=next;break;}
        if(!this.speed||this.position>=next){this.position=next;break;}
        this.anchor=this.time.now();this.advancing=true;this.publish();
        await this.time.wait(Math.min(50,(next-this.position)/this.speed),signal);
        this.settle();this.advancing=false;
      }
      signal.throwIfAborted();
    } finally {this.settle();this.advancing=false;this.waiting=false;this.publish();}
  }
}
