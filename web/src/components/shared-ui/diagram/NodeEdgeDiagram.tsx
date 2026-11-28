import React from 'react';
import * as dagre from '@dagrejs/dagre';
import type { RichDiagramNode } from '../../../../../shared/rich-schema';
import type { RichEvalContext } from '../RichExprEvaluator';
import { color, evaluate, safeArray, type RenderCycle, type SelectValue } from '../runtime';
type Node=Extract<RichDiagramNode,{type:'node_edge_diagram'}>;
interface Vertex{id:string;label:string;sublabel?:string;tone?:string;x?:number;y?:number}
interface Edge{id?:string;from:string;to:string;label?:string;style?:'solid'|'dashed';directed?:boolean}
function wrapLabel(text: string, limit: number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '', width = 0;
    for (const char of paragraph) {
      const size = char.codePointAt(0)! > 0xff ? 2 : 1;
      if (width + size > limit) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += char;
      width += size;
    }
    lines.push(line);
  }
  return lines;
}

export function renderNodeEdgeDiagram(node:Node,context:RichEvalContext,cycle:RenderCycle,select:SelectValue,prefix:string){
  const vertices=safeArray<Vertex>(evaluate(node.nodes,context,cycle),cycle);
  const edges=safeArray<Edge>(evaluate(node.edges,context,cycle),cycle);
  if(vertices.length>500||edges.length>1000)throw Error('図の項目数が上限を超えました。');
  const ids=new Set<string>();for(const v of vertices){if(ids.has(v.id))throw Error('図の項目が重複しています。');ids.add(v.id)}
  if(edges.some(edge=>!ids.has(edge.from)||!ids.has(edge.to)))throw Error('図の接続先が無効です。');
  const valid=edges;
  const labels=new Map(vertices.map(vertex=>{
    const title=wrapLabel(vertex.label,28),subtitle=vertex.sublabel?wrapLabel(vertex.sublabel,32):[];
    const width=224,height=Math.max(54,20+title.length*16+subtitle.length*14);
    return [vertex.id,{title,subtitle,width,height}];
  }));
  const edgeLabels=edges.map(edge=>edge.label?wrapLabel(edge.label,30):[]);
  const maxVertexHeight=Math.max(54,...Array.from(labels.values(),label=>label.height));
  const pos=new Map<string,{x:number;y:number}>();
  const routes=new Map<number,{x:number;y:number}[]>();
  const labelPositions=new Map<number,{x:number;y:number}>();
  if(node.diagramLayout==='dag_lr'||node.diagramLayout==='dag_tb'){
    // Use internal numeric IDs: the user-controlled labels and identifiers never
    // become keys in the graph library's internal object maps.
    const safeIds=new Map(vertices.map((v,i)=>[v.id,'n'+i]));
    const graph=new dagre.graphlib.Graph({multigraph:true});
    graph.setGraph({rankdir:node.diagramLayout==='dag_lr'?'LR':'TB',ranksep:60,nodesep:36,marginx:12,marginy:12});
    graph.setDefaultEdgeLabel(()=>({}));
    for(const v of vertices)graph.setNode(safeIds.get(v.id)!,labels.get(v.id)!);
    valid.forEach((e,i)=>graph.setEdge(safeIds.get(e.from)!,safeIds.get(e.to)!,{width:e.label?216:0,height:edgeLabels[i].length*15},'e'+i));
    dagre.layout(graph);
    for(const v of vertices){const p=graph.node(safeIds.get(v.id)!);pos.set(v.id,{x:p.x,y:p.y})}
    valid.forEach((e,i)=>{const edge=graph.edge({v:safeIds.get(e.from)!,w:safeIds.get(e.to)!,name:'e'+i});if(edge?.points)routes.set(i,edge.points);if(edge&&Number.isFinite(edge.x)&&Number.isFinite(edge.y))labelPositions.set(i,{x:edge.x,y:edge.y})});
  }else{
    vertices.forEach((v,i)=>pos.set(v.id,{x:128+(i%4)*256,y:maxVertexHeight/2+12+Math.floor(i/4)*(maxVertexHeight+48)}));
  }
  if(node.diagramLayout==='radial')vertices.forEach((v,i)=>{const radius=Math.max(130,vertices.length*Math.max(44,maxVertexHeight/5));const angle=i/Math.max(1,vertices.length)*Math.PI*2;pos.set(v.id,{x:radius+90+radius*Math.cos(angle),y:radius+50+radius*Math.sin(angle)})});
  if(node.diagramLayout==='manual')for(const v of vertices){if(Number.isFinite(v.x)&&Number.isFinite(v.y))pos.set(v.id,{x:v.x!,y:v.y!})}
  const all=[...pos.values(),...Array.from(routes.values()).flat(),...labelPositions.values()];
  const labelHeight=Math.max(maxVertexHeight/2,...edgeLabels.map(lines=>lines.length*15/2))+12;
  const minX=Math.min(0,...all.map(p=>p.x-124)),minY=Math.min(0,...all.map(p=>p.y-labelHeight));
  const maxX=Math.max(160,...all.map(p=>p.x+124)),maxY=Math.max(100,...all.map(p=>p.y+labelHeight));
  const interactive=Boolean(node.selectedNodeBind||node.onNodeSelect?.length);
  const arrow=prefix+'-arrow';
  const lineColor='var(--text-muted)';
  const edgeText=(index:number,x:number,y:number)=><text x={x} y={y-(edgeLabels[index].length-1)*7.5} textAnchor="middle" fill="currentColor" fontSize="12">{edgeLabels[index].map((line,i)=><tspan key={i} x={x} dy={i?15:0}>{line}</tspan>)}</text>;
  return <><svg className="rich-svg-scene" viewBox={[minX,minY,maxX-minX,maxY-minY].join(' ')} role={interactive?'group':'img'} aria-label="関係図" style={{width:'100%',maxHeight:600}}>
    <defs><marker id={arrow} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill={lineColor}/></marker></defs>
    {valid.map((e,i)=>{
      const a=pos.get(e.from)!,b=pos.get(e.to)!;
      const route=routes.get(i);
      if(route&&route.length>1){
        const mid=labelPositions.get(i)??route[Math.floor(route.length/2)];
        return <g key={e.id??i}><path d={route.map((p,j)=>(j?'L ':'M ')+p.x+' '+p.y).join(' ')} fill="none" stroke={lineColor} strokeWidth="1.5" strokeDasharray={e.style==='dashed'?'4 3':undefined} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>{e.label&&edgeText(i,mid.x,mid.y)}</g>;
      }
      const from=labels.get(e.from)!,to=labels.get(e.to)!;
      if(e.from===e.to)return <g key={e.id??i}><path d={`M ${a.x+from.width/2-4} ${a.y-12} q 40 -52 5 0`} fill="none" stroke={lineColor} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>{e.label&&edgeText(i,a.x,a.y-from.height/2-20)}</g>;
      const dx=b.x-a.x,dy=b.y-a.y;
      const f=1/Math.max(Math.abs(dx)/(from.width/2),Math.abs(dy)/(from.height/2),1);
      const g=1/Math.max(Math.abs(dx)/(to.width/2),Math.abs(dy)/(to.height/2),1);
      return <g key={e.id??i}><line x1={a.x+dx*f} y1={a.y+dy*f} x2={b.x-dx*g} y2={b.y-dy*g} stroke={lineColor} strokeWidth="1.5" strokeDasharray={e.style==='dashed'?'4 3':undefined} markerEnd={e.directed===false?undefined:'url(#'+arrow+')'}/>{e.label&&edgeText(i,(a.x+b.x)/2,(a.y+b.y)/2-4)}</g>
    })}
    {vertices.map((v,i)=>{
      const p=pos.get(v.id)!,label=labels.get(v.id)!;const choose=()=>select(node.selectedNodeBind,v.id,node.onNodeSelect,{...context,item:v,index:i});
      return <g key={v.id} transform={'translate('+p.x+' '+p.y+')'} {...(interactive?{role:'button',tabIndex:0,'aria-label':v.label,onClick:choose,onKeyDown:(e:React.KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}}}:{})}>
      <rect x={-label.width/2} y={-label.height/2} width={label.width} height={label.height} rx="9" fill="var(--bg-surface)" stroke={v.tone?color(v.tone):'var(--border-strong)'}/>
      <title>{[v.label,v.sublabel].filter(Boolean).join(' · ')}</title>
      <text y={-label.height/2+20} textAnchor="middle" fill="currentColor" fontSize="13">
        {label.title.map((line,i)=><tspan key={i} x="0" dy={i?16:0}>{line}</tspan>)}
        {label.subtitle.map((line,i)=><tspan key={'sub-'+i} x="0" dy={14} fill="var(--text-muted)" fontSize="11">{line}</tspan>)}
      </text></g>
    })}
  </svg>
    <details className="muted-xs"><summary>図の項目と接続</summary>
      <ul>{vertices.map(vertex=><li key={vertex.id}>{vertex.label}{vertex.sublabel&&' — '+vertex.sublabel}</li>)}</ul>
      <ul>{edges.map((edge,index)=><li key={edge.id??index}>{vertices.find(vertex=>vertex.id===edge.from)!.label}
        {edge.directed===false?' ↔ ':' → '}{vertices.find(vertex=>vertex.id===edge.to)!.label}{edge.label&&' — '+edge.label}</li>)}</ul>
    </details></>;
}
