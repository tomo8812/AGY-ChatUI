import React from 'react';
import { extent, sum } from 'd3-array';
import { scaleLinear, scaleBand } from 'd3-scale';
import { arc as d3Arc, line as d3Line, area as d3Area } from 'd3-shape';
import type { RichChartNode, RichChartDatum } from '../../../../../shared/rich-schema';
import type { RichEvalContext } from '../RichExprEvaluator';
import { formatDisplayDate, parseDisplayDate } from '../display/formatDate';
import { toneClass } from '../display/RichBadge';
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
export const parseChartTime = parseDisplayDate;
export const formatChartTime = formatDisplayDate;

function axisFormatter(axis?: { unit?: string; format?: string; type?: string }) {
  const spec = axis?.format;
  let formatNumber = fmt;
  if (spec && spec.length <= 48 && spec !== 'text' && !/\d{3}/.test(spec)) {
    const presets: Record<string, string> = { percent: '.0%', number: ',.2~f', compact: '~s', integer: ',d' };
    try { formatNumber = scaleLinear().tickFormat(5, Object.hasOwn(presets, spec) ? presets[spec] : spec); }
    catch { /* Use the default number format for unknown specifications. */ }
  }
  return (value: number | string) => {
    const label = axis?.type === 'time' ? formatChartTime(typeof value === 'number' ? value : parseChartTime(value), spec) :
      typeof value === 'number' && spec !== 'text' ? formatNumber(value) : String(value);
    return label + (axis?.unit ? ' ' + axis.unit : '');
  };
}
interface PlotPoint { x:number; y:number; base:number }
const linePath=d3Line<PlotPoint|null>().defined(p=>p!==null).x(p=>p!.x).y(p=>p!.y);
const areaPath=d3Area<PlotPoint|null>().defined(p=>p!==null).x(p=>p!.x).y0(p=>p!.base).y1(p=>p!.y);
const slicePath=d3Arc();
export function renderRichChart({ node, context, cycle, select, clipId }: {
  node: RichChartNode; context: RichEvalContext; cycle: RenderCycle; select: SelectValue; clipId: string;
}) {
  const val = <T,>(v: T | { expr: string } | undefined) => evaluate<T>(v, context, cycle);
  const formatX = axisFormatter(node.xAxis);
  const formatLeft = axisFormatter(node.yAxis);
  const formatRight = axisFormatter(node.yAxisRight);
  const categories = safeArray<string | number>(val(node.categories), cycle);
  const series: Series[] = node.series.map((s, index) => ({
    key: s.key, label: text(val(s.label), s.key), color: color(s.colorToken, index),
    type: node.chartType === 'combo' ? s.type ?? 'line' :
      node.chartType === 'scatter' ? 'scatter' : node.chartType.includes('area') ? 'area' :
      node.chartType.includes('bar') ? 'bar' : 'line',
    right: s.yAxisId === 'right', unit: s.unit, sourceId: s.sourceId, asOf: text(val(s.asOf)),
    points: safeArray<number | null | RichChartDatum>(val(s.data), cycle).map((p, i) => {
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
  const details = (s: Series, p: Point) => [s.label, p.label ?? formatX(p.x), p.y === null ? p.missingReason ?? 'データなし' : s.unit ? fmt(p.y) + s.unit : (s.right ? formatRight : formatLeft)(p.y), p.sourceId ?? s.sourceId, p.asOf ?? s.asOf].filter(Boolean).join(' · ');
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
    const total = sum(slices, ({p}) => Math.max(0,p.y??0));
    let angle = 0;
    figure = finite(total) && total > 0 ? slices.map(({ s, p, i }, j) => {
      if (p.y === null || p.y <= 0) return null;
      const start = angle;
      angle += p.y / total * Math.PI * 2;
      return <path key={s.key + ':' + i} d={slicePath({outerRadius:128,innerRadius:node.chartType==='donut'?78:0,startAngle:start,endAngle:angle})??undefined} transform={'translate('+W/2+' '+H/2+')'}
        fill={color(undefined, j)} stroke="var(--bg-surface)" strokeWidth="1" {...activate(s, p, i)}><title>{details(s, p)}</title></path>;
    }) : <text x={W/2} y={H/2} textAnchor="middle" fill="currentColor">表示できる値がありません</text>;
    legend = slices.map(({s,p,i},j) => <span key={s.key+':'+i}><i style={{background: color(undefined,j)}} />{p.label ?? p.x} · {p.y === null ? '—' : fmt(p.y)}</span>);
  } else {
    const stacked = node.chartType === 'stacked_bar' || node.chartType === 'stacked_area';
    const horizontal = node.chartType === 'hbar';
    const numericX = node.xAxis?.type === 'number' || node.xAxis?.type === 'time';
    const xn = (x: string | number) => node.xAxis?.type === 'time'
      ? parseChartTime(x)
      : typeof x === 'number' || x.trim() ? Number(x) : NaN;
    const dataX = series.flatMap(s => s.points.map(p => p.x));
    const cat = [...new Set([...categories, ...dataX])];
    const xvals = numericX ? [...new Set(cat.map(xn).filter(finite))].sort((a,b)=>a-b) : [];
    const [xmin = 0, xmax = 1] = extent(xvals);
    const plotStart = horizontal ? T : L;
    const plotSize = horizontal ? ph : pw;
    const barSeries = series.filter(s => s.type === 'bar');
    const hasBars = barSeries.length > 0;
    const hasRightAxis = series.some(s=>s.right);
    const band = scaleBand<string | number>().domain(cat).range([plotStart,plotStart+plotSize]);
    let gap = xmax-xmin;
    for (let i=1;i<xvals.length;i++) gap=Math.min(gap,xvals[i]-xvals[i-1]);
    const padding = xmin===xmax ? Math.max(1,Math.abs(xmin)*Number.EPSILON) : hasBars ? gap/2 : 0;
    const xScale = scaleLinear().domain([xmin-padding,xmax+padding]).range([plotStart,plotStart+plotSize]);
    const slot = numericX ? (xvals.length>1 ? Math.abs(xScale(xmin+gap)-xScale(xmin)) : plotSize/2) : band.bandwidth();
    const xKey = (x: string | number) => numericX ? xn(x) : x;
    const sx = (x: string | number) => {
      if(numericX)return xScale(xn(x));
      const start=band(x);
      return start===undefined?NaN:start+slot/2;
    };
    type Stacks = { pos: Map<string|number,number>; neg: Map<string|number,number> };
    const groups:Record<'left'|'right',Stacks> = {left:{pos:new Map(),neg:new Map()},right:{pos:new Map(),neg:new Map()}};
    const values = { left: [0], right: [0] };
    const prepared = series.map(s => {
      const axis = s.right ? 'right' : 'left';
      return s.points.map(p => {
        const key=xKey(p.x);
        const x=sx(p.x);
        if (p.y === null || !finite(x)) return null;
        const accumulator = p.y >= 0 ? groups[axis].pos : groups[axis].neg;
        const base = stacked ? accumulator.get(key) ?? 0 : 0;
        const top = base + p.y;
        if (stacked) accumulator.set(key,top);
        values[axis].push(top, base);
        return {base, top, x};
      });
    });
    for (const ref of node.referenceLines ?? []) {
      const v = val(ref.value);
      if (ref.axis === 'y' && finite(v)) values.left.push(v);
    }
    const bounds = (right: boolean) => {
      const axis = right ? node.yAxisRight : node.yAxis;
      const a = values[right ? 'right' : 'left'];
      const [dataMin=0,dataMax=1]=extent(a.filter(finite));
      const min = num(val(axis?.min), dataMin);
      const max = num(val(axis?.max), dataMax);
      return max > min ? [min,max] : [min,min+1];
    };
    const left = bounds(false), right = bounds(true);
    const leftScale=scaleLinear().domain(left).range([0,1]),rightScale=scaleLinear().domain(right).range([0,1]);
    const scale = (v:number, r:boolean) => (r?rightScale:leftScale)(v);
    const sy = (v:number,r:boolean) => T + ph*(1-scale(v,r));
    const hx = (v:number,r:boolean) => L+pw*scale(v,r);
    const axes = Array.from({length:5}, (_,i) => {
      const ratio = i/4;
      const a = left[0] + ratio*(left[1]-left[0]);
      const b = right[0] + ratio*(right[1]-right[0]);
      const y = T+ph*(1-ratio), x = L+pw*ratio;
      return horizontal ? <g key={i}><line x1={x} x2={x} y1={T} y2={T+ph} stroke="var(--border)" /><text x={x} y={T+ph+16} textAnchor="middle">{formatLeft(a)}</text>{hasRightAxis&&<text x={x} y={T-3} textAnchor="middle">{formatRight(b)}</text>}</g> :
        <g key={i}><line x1={L} x2={L+pw} y1={y} y2={y} stroke="var(--border)" /><text x={L-8} y={y+4} textAnchor="end">{formatLeft(a)}</text>{hasRightAxis&&<text x={W-R+8} y={y+4}>{formatRight(b)}</text>}</g>;
    });
    const marks = series.map((s,j) => {
      const pts = prepared[j];
      if (s.type === 'bar') {
        const barWidth = slot*0.8/(stacked ? 1 : Math.max(1,barSeries.length));
        const offset = -slot*0.4 + (stacked ? 0 : barSeries.indexOf(s)*barWidth) + barWidth*0.025;
        return pts.map((p,i) => {
          if (!p) return null;
          const x1=hx(p.base,s.right), x2=hx(p.top,s.right);
          const y1=sy(p.base,s.right), y2=sy(p.top,s.right);
          return <rect key={s.key+':'+i} fill={s.color}
            x={horizontal ? Math.min(x1,x2) : p.x+offset}
            y={horizontal ? p.x+offset : Math.min(y1,y2)}
            width={horizontal ? Math.abs(x2-x1) : barWidth*0.95}
            height={horizontal ? barWidth*0.95 : Math.abs(y2-y1)} {...activate(s,s.points[i],i)}><title>{details(s,s.points[i])}</title></rect>;
        });
      }
      const mapped = pts.map(p => p && { x:p.x, y:sy(p.top,s.right), base:sy(p.base,s.right) });
      const pathData=node.connectNulls?mapped.filter(p=>p!==null):mapped;
      return <g key={s.key}>{s.type !== 'scatter' && <>
        {s.type==='area'&&<path d={areaPath(pathData)??undefined} fill={s.color} opacity={0.22}/>}
        <path d={linePath(pathData)??undefined} stroke={s.color} strokeWidth="2.5" fill="none"/>
      </>}{mapped.map((p,i)=>p && <circle key={i} cx={p.x} cy={p.y} r={s.type==='scatter'?4:3} fill={s.color} {...activate(s,s.points[i],i)}><title>{details(s,s.points[i])}</title></circle>)}</g>;
    });
    const xLabels = numericX ? (xvals.length <= 1 ? xvals : Array.from({length:5},(_,i)=>xmin+(xmax-xmin)*i/4)) : cat;
    const labelStep=Math.max(1,Math.ceil(xLabels.length/8));
    figure = <g className="rich-chart-axes" fill="currentColor" fontSize="12">
      {axes}
      {xLabels.map((x,i) => {
        if(i%labelStep!==0)return null;
        const position=numericX?xScale(Number(x)):sx(x);
        return <text key={i} x={horizontal?L-8:position} y={horizontal?position+4:H-B+17} textAnchor={horizontal?'end':'middle'}>{formatX(x)}</text>;
      })}
      <defs><clipPath id={clipId}><rect x={L} y={T} width={pw} height={ph}/></clipPath></defs>
      <g clipPath={'url(#'+clipId+')'}>{marks}
      {(node.referenceLines??[]).map((r,i)=>{
        const v=val(r.value);
        const vertical = horizontal ? r.axis==='y' : r.axis==='x';
        const pos = r.axis==='x' && (typeof v==='number'||typeof v==='string') ? sx(v)
          : r.axis==='y' && finite(v) ? (horizontal?hx(v,false):sy(v,false)) : NaN;
        if (!finite(pos)) return null;
        return <g key={i} className={'rich-chart-reference'+toneClass(r.tone)}><line x1={vertical?pos:L} x2={vertical?pos:L+pw} y1={vertical?T:pos} y2={vertical?T+ph:pos} stroke="currentColor" strokeDasharray="5 4"/><text x={vertical?pos+3:L+4} y={vertical?T+14:pos-4}>{text(val(r.label))}</text></g>;
      })}
      </g>
      {(horizontal ? node.yAxis?.label : node.xAxis?.label) && <text x={W/2} y={H-5} textAnchor="middle">{horizontal ? node.yAxis?.label : node.xAxis?.label}</text>}
      {(horizontal ? node.xAxis?.label : node.yAxis?.label) && <text x={12} y={H/2} transform={'rotate(-90 12 '+H/2+')'} textAnchor="middle">{horizontal ? node.xAxis?.label : node.yAxis?.label}</text>}
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
