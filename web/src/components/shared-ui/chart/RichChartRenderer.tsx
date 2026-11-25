import React from 'react';
import type { RichChartNode, RichChartDatum } from '../../../../../shared/rich-schema';
import type { RichEvalContext } from '../RichExprEvaluator';
import { color, evaluate, num, safeArray, text, type RenderCycle, type SelectValue } from '../runtime';

interface Point { x: string | number; y: number | null; label?: string; sourceId?: string; asOf?: string; missingReason?: string }
interface Series { key: string; label: string; color: string; type: 'line' | 'bar' | 'area' | 'scatter'; right: boolean; points: Point[]; unit?: string; sourceId?: string; asOf?: string }
const W = 640;
const H = 310;
const L = 62;
const R = 58;
const T = 15;
const B = 42;
const pw = W - L - R;
const ph = H - T - B;
const fmt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(n) >= 100000 ? 'compact' : 'standard' }).format(n);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const timeFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
/** Date-only values represent local calendar dates; explicit offsets represent instants. */
export function parseChartTime(value: string | number): number {
  const date = typeof value === 'number' ? new Date(value) : /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(value + 'T00:00:00') : new Date(value);
  return date.getTime();
}
export function formatChartTime(value: number): string {
  return Number.isFinite(new Date(value).getTime()) ? timeFormat.format(value) : '—';
}
function pathSegments(points: Array<{ x: number; y: number; base: number } | null>, connect: boolean) {
  const segments: Array<Array<{ x: number; y: number; base: number }>> = [];
  let segment: Array<{ x: number; y: number; base: number }> = [];
  for (const point of points) {
    if (point) segment.push(point);
    else if (!connect && segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  return segments;
}
function arc(cx: number, cy: number, outer: number, inner: number, start: number, end: number) {
  const point = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)].join(' ');
  const span = Math.min(end - start, 2 * Math.PI - 0.00001);
  end = start + span;
  const flag = span > Math.PI ? 1 : 0;
  return 'M ' + point(outer, start) + ' A ' + outer + ' ' + outer + ' 0 ' + flag + ' 1 ' + point(outer, end) +
    (inner > 0 ? ' L ' + point(inner, end) + ' A ' + inner + ' ' + inner + ' 0 ' + flag + ' 0 ' + point(inner, start) : ' L ' + cx + ' ' + cy) + ' Z';
}
export function renderRichChart({ node, context, cycle, select, clipId }: {
  node: RichChartNode; context: RichEvalContext; cycle: RenderCycle; select: SelectValue; clipId: string;
}) {
  const val = <T,>(v: T | { expr: string } | undefined) => evaluate<T>(v, context, cycle);
  const categories = safeArray<string | number>(val(node.categories));
  const series: Series[] = node.series.map((s, index) => ({
    key: s.key, label: text(val(s.label), s.key), color: color(s.colorToken, index),
    type: node.chartType === 'combo' ? s.type ?? 'line' :
      node.chartType === 'scatter' ? 'scatter' : node.chartType.includes('area') ? 'area' :
      node.chartType.includes('bar') ? 'bar' : 'line',
    right: s.yAxisId === 'right', unit: s.unit, sourceId: s.sourceId, asOf: text(val(s.asOf)),
    points: safeArray<number | null | RichChartDatum>(val(s.data)).map((p, i) => {
      const d = p && typeof p === 'object' ? p : { y: p };
      return { ...d, x: 'x' in d && (typeof d.x === 'number' || typeof d.x === 'string') ? d.x : categories[i] ?? i + 1,
        y: finite(d.y) ? d.y : null };
    }),
  }));
  const interactive = Boolean(node.selectedPointBind || node.onPointSelect?.length);
  const choose = (s: Series, p: Point, i: number) => {
    const data = { seriesKey: s.key, dataIndex: i, x: p.x, y: p.y };
    select(node.selectedPointBind, data, node.onPointSelect, { ...context, item: data, index: i });
  };
  const details = (s: Series, p: Point) => [s.label, p.label ?? p.x, p.y === null ? p.missingReason ?? 'データなし' : fmt(p.y) + (s.unit ?? ''), p.sourceId ?? s.sourceId, p.asOf ?? s.asOf].filter(Boolean).join(' · ');
  const activate = (s: Series, p: Point, i: number) => interactive ? {
    role: 'button', tabIndex: 0, 'aria-label': details(s, p),
    onClick: () => choose(s, p, i), onKeyDown: (e: React.KeyboardEvent<SVGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(s, p, i); }
    },
  } : {};
  const title = text(val(node.title));
  const missing = series.flatMap(s => s.points.filter(p => p.y === null).map(p => details(s, p)));
  let figure: React.ReactNode;
  let legend: React.ReactNode = series.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}{s.sourceId && <small> · {s.sourceId}</small>}</span>);
  if (node.chartType === 'pie' || node.chartType === 'donut') {
    const slices = series.flatMap(s => s.points.map((p, i) => ({ s, p, i })));
    const sum = slices.reduce((total, { p }) => total + Math.max(0, p.y ?? 0), 0);
    let angle = -Math.PI / 2;
    figure = sum > 0 ? slices.map(({ s, p, i }, j) => {
      if (p.y === null || p.y <= 0) return null;
      const start = angle;
      angle += p.y / sum * Math.PI * 2;
      return <path key={s.key + ':' + i} d={arc(W / 2, H / 2, 128, node.chartType === 'donut' ? 78 : 0, start, angle)}
        fill={color(undefined, j)} stroke="var(--bg-surface)" strokeWidth="1" {...activate(s, p, i)}><title>{details(s, p)}</title></path>;
    }) : <text x={W/2} y={H/2} textAnchor="middle" fill="currentColor">表示できる値がありません</text>;
    legend = slices.map(({s,p,i},j) => <span key={s.key+':'+i}><i style={{background: color(undefined,j)}} />{p.label ?? p.x} · {p.y === null ? '—' : fmt(p.y)}</span>);
  } else {
    const stacked = node.chartType === 'stacked_bar' || node.chartType === 'stacked_area';
    const horizontal = node.chartType === 'hbar';
    const count = Math.max(1, ...series.map(s => s.points.length), categories.length);
    const cat = Array.from({length:count}, (_,i) => categories[i] ?? series.find(s => s.points[i])?.points[i].x ?? i+1);
    const numericX = !horizontal && !stacked && !series.some(s => s.type === 'bar') && node.xAxis?.type !== undefined && node.xAxis.type !== 'category';
    const xn = (x: string | number) => node.xAxis?.type === 'time' ? parseChartTime(x) : Number(x);
    const xvals = numericX ? series.flatMap(s => s.points.map(p => xn(p.x))).filter(finite) : [];
    const xmin = xvals.length ? Math.min(...xvals) : 0;
    const xmax = xvals.length ? Math.max(...xvals) : 1;
    const sx = (p: Point, i: number) => numericX && finite(xn(p.x)) ? L + (xn(p.x)-xmin)/(xmax-xmin || 1)*pw : L + (i+0.5)/count*pw;
    const groups = { left: { pos: Array(count).fill(0) as number[], neg: Array(count).fill(0) as number[] },
      right: { pos: Array(count).fill(0) as number[], neg: Array(count).fill(0) as number[] } };
    const values = { left: [0], right: [0] };
    const prepared = series.map(s => {
      const axis = s.right ? 'right' : 'left';
      return s.points.map((p,i) => {
        if (p.y === null) return null;
        const accumulator = p.y >= 0 ? groups[axis].pos : groups[axis].neg;
        const base = stacked ? accumulator[i] : 0;
        const top = base + p.y;
        if (stacked) accumulator[i] = top;
        values[axis].push(top, base);
        return {base, top};
      });
    });
    for (const ref of node.referenceLines ?? []) {
      const v = val(ref.value);
      if (ref.axis === 'y' && finite(v)) values.left.push(v);
    }
    const bounds = (right: boolean) => {
      const axis = right ? node.yAxisRight : node.yAxis;
      const a = values[right ? 'right' : 'left'];
      const min = num(val(axis?.min), Math.min(...a));
      const max = num(val(axis?.max), Math.max(...a));
      return max > min ? [min,max] : [min,min+1];
    };
    const left = bounds(false), right = bounds(true);
    const scale = (v:number, r:boolean) => { const [a,b] = r ? right : left; return (v-a)/(b-a); };
    const sy = (v:number,r:boolean) => T + ph*(1-scale(v,r));
    const hx = (v:number,r:boolean) => L+pw*scale(v,r);
    const barSeries = series.filter(s => s.type === 'bar');
    const axes = Array.from({length:5}, (_,i) => {
      const ratio = i/4;
      const a = left[0] + ratio*(left[1]-left[0]);
      const b = right[0] + ratio*(right[1]-right[0]);
      const y = T+ph*(1-ratio), x = L+pw*ratio;
      return horizontal ? <g key={i}><line x1={x} x2={x} y1={T} y2={T+ph} stroke="var(--border)" /><text x={x} y={T+ph+16} textAnchor="middle">{fmt(a)}</text></g> :
        <g key={i}><line x1={L} x2={L+pw} y1={y} y2={y} stroke="var(--border)" /><text x={L-8} y={y+4} textAnchor="end">{fmt(a)}</text>{series.some(s=>s.right)&&<text x={W-R+8} y={y+4}>{fmt(b)}</text>}</g>;
    });
    const marks = series.map((s,j) => {
      const pts = prepared[j];
      if (s.type === 'bar') {
        const slot = (horizontal ? ph : pw)/count;
        const barWidth = slot*0.8/(stacked ? 1 : Math.max(1,barSeries.length));
        const offset = stacked ? 0 : barSeries.indexOf(s)*barWidth;
        return pts.map((p,i) => {
          if (!p) return null;
          const x1=hx(p.base,s.right), x2=hx(p.top,s.right);
          const y1=sy(p.base,s.right), y2=sy(p.top,s.right);
          return <rect key={s.key+':'+i} fill={s.color}
            x={horizontal ? Math.min(x1,x2) : L+i*slot+slot*0.1+offset}
            y={horizontal ? T+i*slot+slot*0.1+offset : Math.min(y1,y2)}
            width={horizontal ? Math.abs(x2-x1) : Math.max(0.5,barWidth-1)}
            height={horizontal ? Math.max(0.5,barWidth-1) : Math.abs(y2-y1)} {...activate(s,s.points[i],i)}><title>{details(s,s.points[i])}</title></rect>;
        });
      }
      const mapped = pts.map((p,i) => p && (!numericX || finite(xn(s.points[i].x))) ? { x:sx(s.points[i],i), y:sy(p.top,s.right), base:sy(p.base,s.right) } : null);
      return <g key={s.key}>{s.type !== 'scatter' && pathSegments(mapped,Boolean(node.connectNulls)).map((seg,i) => {
        const line = seg.map((p,k)=>(k?' L ':'M ')+p.x+' '+p.y).join('');
        const area = line+seg.slice().reverse().map(p=>' L '+p.x+' '+p.base).join('')+' Z';
        return <g key={i}>{s.type === 'area' && <path d={area} fill={s.color} opacity={0.22}/>}<path d={line} stroke={s.color} strokeWidth="2.5" fill="none"/></g>;
      })}{mapped.map((p,i)=>p && <circle key={i} cx={p.x} cy={p.y} r={s.type==='scatter'?4:3} fill={s.color} {...activate(s,s.points[i],i)}><title>{details(s,s.points[i])}</title></circle>)}</g>;
    });
    const labelStep=Math.max(1,Math.ceil(count/8));
    figure = <g className="rich-chart-axes" fill="currentColor" fontSize="12">
      {axes}
      {!numericX && cat.map((x,i) => i%labelStep===0 && <text key={i} x={horizontal ? L-8 : L+(i+0.5)/count*pw} y={horizontal ? T+(i+0.5)/count*ph+4 : H-B+17} textAnchor={horizontal?'end':'middle'}>{String(x).slice(0,14)}</text>)}
      {numericX && Array.from({length:5},(_,i)=>{const x=xmin+(xmax-xmin)*i/4;return <text key={i} x={L+pw*i/4} y={H-B+17} textAnchor="middle">{node.xAxis?.type==='time'?formatChartTime(x):fmt(x)}</text>})}
      <defs><clipPath id={clipId}><rect x={L} y={T} width={pw} height={ph}/></clipPath></defs>
      <g clipPath={'url(#'+clipId+')'}>{marks}
      {(node.referenceLines??[]).map((r,i)=>{
        const v=val(r.value); const idx=cat.findIndex(x=>x===v);
        const x = numericX ? L+(xn(v as string|number)-xmin)/(xmax-xmin||1)*pw : L+(idx+0.5)/count*pw;
        const y = sy(num(v,0),false);
        const vertical = horizontal ? r.axis==='y' : r.axis==='x';
        const pos = horizontal ? (r.axis==='y'?hx(num(v,0),false):T+(idx+0.5)/count*ph) : r.axis==='y'?y:x;
        if (!Number.isFinite(pos) || (r.axis==='x'&&!numericX&&idx<0)) return null;
        return <g key={i}><line x1={vertical?pos:L} x2={vertical?pos:L+pw} y1={vertical?T:pos} y2={vertical?T+ph:pos} stroke="var(--text-muted)" strokeDasharray="5 4"/><text x={vertical?pos+3:L+4} y={vertical?T+14:pos-4}>{text(val(r.label))}</text></g>;
      })}
      </g>
      {node.xAxis?.label && <text x={W/2} y={H-5} textAnchor="middle">{node.xAxis.label}</text>}
      {node.yAxis?.label && <text x={12} y={H/2} transform={'rotate(-90 12 '+H/2+')'} textAnchor="middle">{node.yAxis.label}</text>}
      {node.yAxisRight?.label && <text x={W-9} y={H/2} transform={'rotate(90 '+(W-9)+' '+H/2+')'} textAnchor="middle">{node.yAxisRight.label}</text>}
    </g>;
  }
  return <figure className="rich-chart" aria-label={title || 'グラフ'}>
    {title && <figcaption>{title}</figcaption>}
    {node.legend==='top' && <div className="rich-chart-legend">{legend}</div>}
    <svg viewBox={'0 0 '+W+' '+H} role={interactive?'group':'img'} aria-label={title||'グラフ'} style={{width:'100%',maxHeight:Math.max(120,Math.min(720,node.heightPx??400))}}>{figure}</svg>
    {node.legend!=='top' && node.legend!=='none' && <div className="rich-chart-legend">{legend}</div>}
    {missing.length>0 && <details className="muted-xs"><summary>欠損値 {missing.length} 件</summary><ul>{missing.slice(0,100).map((m,i)=><li key={i}>{m}</li>)}</ul>{missing.length>100&&<p>ほか {missing.length-100} 件</p>}</details>}
  </figure>;
}
