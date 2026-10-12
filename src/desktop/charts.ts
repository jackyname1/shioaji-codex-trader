import type { ChartData } from '../core/chart.js';
const ns = 'http://www.w3.org/2000/svg';
function node(tag: string, attrs: Record<string, string | number> = {}, content?: string): SVGElement {
  const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (content !== undefined) n.textContent = content; return n;
}
export interface ChartOptions { ma: boolean; bands: boolean; rsi: boolean; offset: number; count: number;
  priceScale?:number;
  levels: { price: number; label: string; color: string }[]; fills: { at: string; action: string; price: string }[] }
export function candles(host: HTMLElement, data: ChartData, options: ChartOptions): void {
  const all = data.bars, end = Math.min(all.length, options.offset + options.count), bars = all.slice(options.offset, end);
  if (!bars.length) { host.textContent = data.issue || '此段時間沒有已知行情'; host.classList.add('chart-empty'); return; }
  host.classList.remove('chart-empty');
  const width=Math.max(300,host.clientWidth||1000),height=Math.max(140,host.clientHeight||(options.rsi?450:390)),left=10,right=60,top=18;
  const axisY=height-6,rsiBottom=height-24,rsiTop=rsiBottom-Math.max(20,Math.min(42,height*.18));
  const volumeHeight=Math.max(14,Math.min(36,height*.14)),volumeBase=options.rsi?rsiTop-8:height-24;
  const bottom=Math.max(top+22,volumeBase-volumeHeight-18),rsiScale=(rsiBottom-rsiTop)/100;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio:'none', role: 'img', 'aria-label': `${data.name} K 線、均線與成交量圖` });
  const prices = bars.flatMap(b => [b.high, b.low, ...(options.bands ? [b.upper ?? b.high, b.lower ?? b.low] : [])]);
  // Out-of-range protection lines are labeled, without collapsing candle visibility.
  let min = Math.min(...prices), max = Math.max(...prices); const pad = Math.max((max - min) * .08, max * .002); min -= pad; max += pad;
  const middle=(min+max)/2,half=(max-min)/2/(options.priceScale??1);min=middle-half;max=middle+half;
  const y = (p: number): number => bottom - (p - min) / (max - min) * (bottom - top);
  const defs=node('defs'),clip=node('clipPath',{id:'chart-price-area'});clip.append(node('rect',{x:left,y:top,width:width-left-right,height:bottom-top}));defs.append(clip);svg.append(defs);
  const priceLayer=node('g',{'clip-path':'url(#chart-price-area)'});svg.append(priceLayer);
  const step = (width - left - right) / bars.length, x = (i: number): number => left + (i + .5) * step;
  for (let i = 0; i <= 5; i++) { const price = min + (max - min) * i / 5, yy = y(price);
    svg.append(node('line', { x1: left, x2: width - right, y1: yy, y2: yy, stroke: 'var(--chart-grid)', 'stroke-dasharray': '3 5' }),
      node('text', { x: width - right + 12, y: yy + 4, fill: 'var(--muted)', 'font-size': 11 }, price.toLocaleString('en', { maximumFractionDigits: 2 })));
  }
  const path = (key: 'ma5' | 'ma20' | 'ma60' | 'upper' | 'lower', color: string): void => {
    const d = bars.map((b, i) => b[key] === undefined ? '' : `${i === 0 || bars[i - 1]![key] === undefined ? 'M' : 'L'}${x(i)},${y(b[key]!)}`).join(' ');
    priceLayer.append(node('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, ...(key === 'upper' || key === 'lower' ? { 'stroke-dasharray': '4 3', opacity: .55 } : {}) }));
  };
  if (options.bands) { path('upper', 'var(--violet)'); path('lower', 'var(--violet)'); }
  const volumeMax = Math.max(1, ...bars.map(b => b.volume));
  for (let i = 0; i < bars.length; i++) { const b = bars[i]!, color = b.close >= b.open ? 'var(--up)' : 'var(--down)', xx = x(i), cw = Math.max(1, Math.min(9, step * .62));
    const group = node('g'); group.append(node('title', {}, `${new Date(b.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}\n開 ${b.open} 高 ${b.high} 低 ${b.low} 收 ${b.close}\n成交量 ${b.volume.toLocaleString()} 股`),
      node('line', { x1: xx, x2: xx, y1: y(b.high), y2: y(b.low), stroke: color, 'stroke-width': 1,'clip-path':'url(#chart-price-area)' }),
      node('rect', { x: xx - cw / 2, y: Math.min(y(b.open), y(b.close)), width: cw, height: Math.max(1, Math.abs(y(b.open) - y(b.close))), fill: color,'clip-path':'url(#chart-price-area)' }),
      node('rect', { x: xx - cw / 2, y: volumeBase - b.volume / volumeMax * volumeHeight, width: cw, height: Math.max(1, b.volume / volumeMax * volumeHeight), fill: color, opacity: .45,'data-pane':'volume' })); svg.append(group);
  }
  if (options.ma) { path('ma5', 'var(--amber)'); path('ma20', 'var(--sky)'); path('ma60', 'var(--violet)'); }
  for (const level of options.levels) if (level.price > 0) {
    const yy = Math.max(top + 3, Math.min(bottom - 3, y(level.price)));
    svg.append(node('line', { x1: left, x2: width - right, y1: yy, y2: yy, stroke: level.color, 'stroke-dasharray': '6 5', opacity: .8 }),
      node('text', { x: left + 8, y: yy - 5, fill: level.color, 'font-size': 11 }, `${level.label} ${level.price}${level.price < min || level.price > max ? '（範圍外）' : ''}`));
  }
  for (const fill of options.fills) {
    if (Date.parse(fill.at) < Date.parse(bars[0]!.at) || Date.parse(fill.at) > Date.parse(bars.at(-1)!.at)) continue;
    const i = bars.findIndex(b => Date.parse(b.at) >= Date.parse(fill.at)); if (i < 0) continue;
    const yy = Math.max(top + 10, Math.min(bottom - 10, y(Number(fill.price)))), buy = fill.action === 'BUY';
    svg.append(node('circle', { cx: x(i), cy: yy, r: 6, fill: buy ? 'var(--up)' : 'var(--down)', stroke: 'var(--field)', 'stroke-width': 2 }),
      node('text', { x: x(i), y: yy + 3, 'text-anchor': 'middle', fill: 'var(--field)', 'font-size': 8, 'font-weight': 800 }, buy ? 'B' : 'S'));
  }
  if (options.rsi) {
    for (const v of [30, 70]) svg.append(node('line', { x1: left, x2: width - right, y1: rsiBottom - v * rsiScale, y2: rsiBottom - v * rsiScale, stroke: 'var(--line)', 'stroke-dasharray': '4 4' }));
    svg.append(node('text', { x: width - right + 10, y: rsiTop+12, fill: 'var(--muted)', 'font-size': 10 }, 'RSI 14'));
    const d = bars.map((b, i) => b.rsi === undefined ? '' : `${i === 0 || bars[i - 1]!.rsi === undefined ? 'M' : 'L'}${x(i)},${rsiBottom - b.rsi * rsiScale}`).join(' ');
    svg.append(node('path', { d, fill: 'none', stroke: 'var(--violet)', 'stroke-width': 1.5,'data-pane':'rsi' }));
  }
  svg.append(node('text', { x: left, y: bottom+12, fill: 'var(--muted)', 'font-size': 10 }, '成交量（股）'));
  for (const i of [0, Math.floor(bars.length / 2), bars.length - 1]) svg.append(node('text', { x: x(i), y: axisY, fill: 'var(--muted)', 'font-size': 10,'data-pane':'time', 'text-anchor': i === 0 ? 'start' : i === bars.length - 1 ? 'end' : 'middle' },
    new Date(bars[i]!.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', ...(data.interval === '1d' ? {} : { hour: '2-digit', minute: '2-digit' }), hour12: false })));
  const cursor = node('line', { x1: 0, x2: 0, y1: top, y2: volumeBase, stroke: 'var(--subtext)', 'stroke-dasharray': '3 3', visibility: 'hidden' }); svg.append(cursor);
  const horizontal=node('line',{x1:left,x2:width-right,y1:0,y2:0,stroke:'var(--subtext)','stroke-dasharray':'3 3',visibility:'hidden'}),priceLabel=node('text',{x:width-right+7,y:0,fill:'var(--text)','font-size':11,visibility:'hidden'});svg.append(horizontal,priceLabel);
  host.dataset.offset=String(options.offset);host.dataset.count=String(bars.length);host.dataset.priceScale=String(options.priceScale??1);
  host.dataset.asof=data.asof;host.dataset.endAt=bars.at(-1)!.at;
  svg.addEventListener('pointermove', event => { const rect = svg.getBoundingClientRect(), xx = (event.clientX - rect.left) / rect.width * width,yy=(event.clientY-rect.top)/rect.height*height;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor((xx - left) / step))); cursor.setAttribute('x1', String(x(i))); cursor.setAttribute('x2', String(x(i))); cursor.setAttribute('visibility', 'visible');
    const inPrice=yy>=top&&yy<=bottom;horizontal.setAttribute('visibility',inPrice?'visible':'hidden');priceLabel.setAttribute('visibility',inPrice?'visible':'hidden');
    if(inPrice){horizontal.setAttribute('y1',String(yy));horizontal.setAttribute('y2',String(yy));priceLabel.setAttribute('y',String(yy-4));priceLabel.textContent=(min+(bottom-yy)/(bottom-top)*(max-min)).toFixed(2);}
    const b=bars[i]!;host.dataset.hover=`${new Date(b.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})} · 開 ${b.open} 高 ${b.high} 低 ${b.low} 收 ${b.close} · 量 ${b.volume.toLocaleString()} 股`;
  });
  svg.addEventListener('pointerleave', () => {for(const line of [cursor,horizontal,priceLabel])line.setAttribute('visibility','hidden');}); host.replaceChildren(svg);
}
export function equityChart(host: HTMLElement, rows: { at: string; equity: string }[], initial: number): void {
  if (!rows.length) { host.textContent = '模擬執行後會顯示資產曲線'; return; }
  const width=Math.max(300,host.clientWidth||1000),height=Math.max(48,host.clientHeight||190),right=width-65,bottom=height-15;
  const stride=Math.max(1,Math.ceil(rows.length/1000)),display=rows.filter((_,i)=>i%stride===0||i===rows.length-1);
  const values=[initial,...display.map(r=>Number(r.equity))];let min=initial,max=initial;
  for(const value of values){min=Math.min(min,value);max=Math.max(max,value);}
  const pad=Math.max((max-min)*.15,initial*.002),lo=min-pad,hi=max+pad;
  const y=(v:number):number=>bottom-(v-lo)/(hi-lo)*(bottom-7),x=(i:number):number=>8+i/Math.max(1,values.length-1)*(right-8);
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio:'none', role: 'img', 'aria-label': '模擬資產與初始本金比較' });
  for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; svg.append(node('line', { x1: 8, x2: right, y1: y(v), y2: y(v), stroke: 'var(--chart-grid)' }),
    node('text', { x: right+7, y: y(v) + 3, fill: 'var(--muted)', 'font-size': 10 }, Math.round(v).toLocaleString())); }
  svg.append(node('line', { x1: 8, x2: right, y1: y(initial), y2: y(initial), stroke: 'var(--muted)', 'stroke-dasharray': '5 5' }));
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' '), color = values.at(-1)! >= initial ? 'var(--down)' : 'var(--up)';
  svg.append(node('path', { d: line + ` L${right},${bottom} L8,${bottom} Z`, fill: color, opacity: .07 }), node('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2.5 }));
  for (const [i, row] of display.entries()) if (i === 0 || i === display.length - 1) svg.append(node('text', { x: x(i + 1), y: height-3, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': i ? 'end' : 'start' },
    new Date(row.at).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })));
  host.replaceChildren(svg);
}
