import React from 'react';
import type { RichDiagramNode } from '../../../../../shared/rich-schema';
import type { RichEvalContext } from '../RichExprEvaluator';
import { color, evaluate, safeArray, text, type RenderCycle, type SelectValue } from '../runtime';
type Node=Extract<RichDiagramNode,{type:'node_edge_diagram'}>;
interface Vertex{id:string;label:string;sublabel?:string;tone?:string;x?:number;y?:number}
interface Edge{id?:string;from:string;to:string;label?:string;style?:'solid'|'dashed';directed?:boolean}
export function renderNodeEdgeDiagram(node:Node,context:RichEvalContext,cycle:RenderCycle,select:SelectValue,prefix:string){
  const vertices=safeArray<Vertex>(evaluate(node.nodes,context,cycle));
  const edges=safeArray<Edge>(evaluate(node.edges,context,cycle));
  if(vertices.length>500||edges.length>1000)throw Error('図の項目数が上限を超えました。');
  const ids=new Set<string>();for(const v of vertices){if(ids.has(v.id))throw Error('図の項目が重複しています。');ids.add(v.id)}
  const valid=edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
  const depth=new Map(vertices.map(v=>[v.id,0]));
  const remaining=new Map(vertices.map(v=>[v.id,0]));
  const outgoing=new Map<string,Edge[]>();
  for(const e of valid){if(e.from===e.to)continue;remaining.set(e.to,(remaining.get(e.to)??0)+1);const list=outgoing.get(e.from)??[];list.push(e);outgoing.set(e.from,list)}
  const queue=vertices.filter(v=>remaining.get(v.id)===0).map(v=>v.id);
  for(let i=0;i<queue.length;i++){const id=queue[i];for(const e of outgoing.get(id)??[]){depth.set(e.to,Math.max(depth.get(e.to)??0,(depth.get(id)??0)+1));const n=(remaining.get(e.to)??0)-1;remaining.set(e.to,n);if(n===0)queue.push(e.to)}}
  const lanes=new Map<number,Vertex[]>();for(const v of vertices){const d=depth.get(v.id)??0;const row=lanes.get(d)??[];row.push(v);lanes.set(d,row)}
  const pos=new Map<string,{x:number;y:number}>();
  const horizontal=node.diagramLayout==='dag_lr';
  for(const [d,row]of lanes){row.forEach((v,i)=>{
    const x=horizontal?d*180+86:i*180+86;
    const y=horizontal?i*90+50:d*115+50;
    pos.set(v.id,{x,y});
  })}
  if(node.diagramLayout==='radial')vertices.forEach((v,i)=>{const radius=Math.max(110,vertices.length*28);const angle=i/Math.max(1,vertices.length)*Math.PI*2;pos.set(v.id,{x:radius+90+radius*Math.cos(angle),y:radius+50+radius*Math.sin(angle)})});
  if(node.diagramLayout==='manual')for(const v of vertices){if(Number.isFinite(v.x)&&Number.isFinite(v.y))pos.set(v.id,{x:v.x!,y:v.y!})}
  const all=[...pos.values()];
  const minX=Math.min(0,...all.map(p=>p.x-85)),minY=Math.min(0,...all.map(p=>p.y-42));
  const maxX=Math.max(160,...all.map(p=>p.x+85)),maxY=Math.max(100,...all.map(p=>p.y+42));
  const interactive=Boolean(node.selectedNodeBind||node.onNodeSelect?.length);
  const arrow=prefix+'-arrow';
  const lineColor='var(--text-muted)';
  return <svg className="rich-svg-scene" viewBox={[minX,minY,maxX-minX,maxY-minY].join(' ')} role={interactive?'group':'img'} aria-label="関係図" style={{width:'100%',maxHeight:600}}>
    <defs><marker id={arrow} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill={lineColor}/></marker></defs>
    {valid.map((e,i)=>{
      const a=pos.get(e.from)!,b=pos.get(e.to)!;
      if(e.from===e.to)return <path key={i} d={'M '+(a.x+60)+' '+(a.y-23)+' q 40 -52 5 0'} fill="none" stroke={lineColor} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>;
      const dx=b.x-a.x,dy=b.y-a.y;
      const f=1/Math.max(Math.abs(dx)/72,Math.abs(dy)/27,1);
      return <g key={e.id??i}><line x1={a.x+dx*f} y1={a.y+dy*f} x2={b.x-dx*f} y2={b.y-dy*f} stroke={lineColor} strokeWidth="1.5" strokeDasharray={e.style==='dashed'?'4 3':undefined} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>{e.label&&<text x={(a.x+b.x)/2} y={(a.y+b.y)/2-4} textAnchor="middle" fill="currentColor" fontSize="12">{e.label}</text>}</g>
    })}
    {vertices.map((v,i)=>{
      const p=pos.get(v.id)!;const choose=()=>select(node.selectedNodeBind,v.id,node.onNodeSelect,{...context,item:v,index:i});
      return <g key={v.id} transform={'translate('+p.x+' '+p.y+')'} {...(interactive?{role:'button',tabIndex:0,'aria-label':v.label,onClick:choose,onKeyDown:(e:React.KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}}}:{})}>
      <rect x="-72" y="-27" width="144" height="54" rx="9" fill="var(--bg-surface)" stroke={v.tone?color(v.tone):'var(--border-strong)'}/><title>{[v.label,v.sublabel].filter(Boolean).join(' · ')}</title><text x="0" y={v.sublabel?-3:5} textAnchor="middle" fill="currentColor" fontSize="13">{text(v.label).slice(0,20)}</text>{v.sublabel&&<text y="14" textAnchor="middle" fill="var(--text-muted)" fontSize="10">{v.sublabel.slice(0,23)}</text>}</g>
    })}
  </svg>;
}
