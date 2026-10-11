const clamp=(n:number,min:number,max:number):number=>Math.max(min,Math.min(max,n));
/** Presentation state only: moving the viewport never changes a replay's clock or data cutoff. */
export class ChartViewport {
  offset=0;count=120;priceScale=1;following=true;
  private times:string[]=[];private key='';
  get total():number{return this.times.length;}
  get visible():number{return Math.min(this.total,this.count);}
  get maximum():number{return Math.max(0,this.total-this.count);}
  sync(times:string[],key:string):void {
    const left=this.times[this.offset],changed=key!==this.key;
    this.times=times;this.key=key;
    if(changed){this.following=true;this.priceScale=1;}
    if(this.following)this.offset=this.maximum;
    else {const anchor=left?times.indexOf(left):-1;this.offset=clamp(anchor<0?this.offset:anchor,0,this.maximum);}
  }
  move(offset:number):void {this.offset=clamp(Math.round(offset),0,this.maximum);this.following=this.offset===this.maximum;}
  pan(bars:number):void {this.move(this.offset+bars);}
  zoom(factor:number,anchor=.5):void {
    if(!this.total||!Number.isFinite(factor)||factor<=0)return;
    const fraction=clamp(anchor,0,1),previous=this.visible;
    const count=clamp(Math.round(previous*factor),Math.min(15,this.total),Math.min(2000,this.total));
    const point=this.offset+fraction*previous;this.count=count;this.move(point-fraction*count);
  }
  setCount(count:number):void {
    if(!Number.isFinite(count)||count<1)return;
    const end=this.offset+this.visible;this.count=clamp(Math.round(count),15,2000);
    this.move(this.following?this.maximum:end-this.visible);
  }
  latest():void {this.following=true;this.offset=this.maximum;}
  fit():void {this.count=clamp(this.total,15,2000);this.priceScale=1;this.latest();}
  reset():void {this.count=120;this.priceScale=1;this.latest();}
  scalePrice(factor:number):void {if(Number.isFinite(factor)&&factor>0)this.priceScale=clamp(this.priceScale*factor,.2,10);}
}
