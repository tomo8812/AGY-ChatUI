import React from 'react';
import * as dagre from '@dagrejs/dagre';
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
  const pos=new Map<string,{x:number;y:number}>();
  const routes=new Map<number,{x:number;y:number}[]>();
  if(node.diagramLayout==='dag_lr'||node.diagramLayout==='dag_tb'){
    // Use internal numeric IDs: the user-controlled labels and identifiers never
    // become keys in the graph library's internal object maps.
    const safeIds=new Map(vertices.map((v,i)=>[v.id,'n'+i]));
    const graph=new dagre.graphlib.Graph({multigraph:true});
    graph.setGraph({rankdir:node.diagramLayout==='dag_lr'?'LR':'TB',ranksep:60,nodesep:36,marginx:12,marginy:12});
    graph.setDefaultEdgeLabel(()=>({}));
    for(const v of vertices)graph.setNode(safeIds.get(v.id)!,{width:144,height:54});
    valid.forEach((e,i)=>graph.setEdge(safeIds.get(e.from)!,safeIds.get(e.to)!,{width:e.label?Math.min(160,e.label.length*7):0,height:e.label?16:0},'e'+i));
    dagre.layout(graph);
    for(const v of vertices){const p=graph.node(safeIds.get(v.id)!);pos.set(v.id,{x:p.x,y:p.y})}
    valid.forEach((e,i)=>{const edge=graph.edge({v:safeIds.get(e.from)!,w:safeIds.get(e.to)!,name:'e'+i});if(edge?.points)routes.set(i,edge.points)});
  }else{
    vertices.forEach((v,i)=>pos.set(v.id,{x:86+(i%4)*180,y:50+Math.floor(i/4)*90}));
  }
  if(node.diagramLayout==='radial')vertices.forEach((v,i)=>{const radius=Math.max(110,vertices.length*28);const angle=i/Math.max(1,vertices.length)*Math.PI*2;pos.set(v.id,{x:radius+90+radius*Math.cos(angle),y:radius+50+radius*Math.sin(angle)})});
  if(node.diagramLayout==='manual')for(const v of vertices){if(Number.isFinite(v.x)&&Number.isFinite(v.y))pos.set(v.id,{x:v.x!,y:v.y!})}
  const all=[...pos.values(),...Array.from(routes.values()).flat()];
  const minX=Math.min(0,...all.map(p=>p.x-85)),minY=Math.min(0,...all.map(p=>p.y-42));
  const maxX=Math.max(160,...all.map(p=>p.x+85)),maxY=Math.max(100,...all.map(p=>p.y+42));
  const interactive=Boolean(node.selectedNodeBind||node.onNodeSelect?.length);
  const arrow=prefix+'-arrow';
  const lineColor='var(--text-muted)';
  return <svg className="rich-svg-scene" viewBox={[minX,minY,maxX-minX,maxY-minY].join(' ')} role={interactive?'group':'img'} aria-label="関係図" style={{width:'100%',maxHeight:600}}>
    <defs><marker id={arrow} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill={lineColor}/></marker></defs>
    {valid.map((e,i)=>{
      const a=pos.get(e.from)!,b=pos.get(e.to)!;
      const route=routes.get(i);
      if(route&&route.length>1){
        const mid=route[Math.floor(route.length/2)];
        return <g key={e.id??i}><path d={route.map((p,j)=>(j?'L ':'M ')+p.x+' '+p.y).join(' ')} fill="none" stroke={lineColor} strokeWidth="1.5" strokeDasharray={e.style==='dashed'?'4 3':undefined} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>{e.label&&<text x={mid.x} y={mid.y-4} textAnchor="middle" fill="currentColor" fontSize="12">{e.label}</text>}</g>;
      }
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
