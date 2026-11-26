import React from 'react';
import type { RichDiagramNode, RichSvgDef, RichSvgElement, RichStateAction } from '../../../../../shared/rich-schema';
import type { RichEvalContext } from '../RichExprEvaluator';
import {
  SVG_ATTRS, SVG_TAGS, isSvgDefinition, svgDefinitionElementCount, svgLocalRef,
  svgRoleMatchesActions, validateSvgAttrValue, validSvgViewBox,
} from '../../../../../server/src/rich/rich-svg-contract';
import { addNode, evaluate, expression, repeatContexts, text, type RenderCycle } from '../runtime';
type Scene = Extract<RichDiagramNode, { type: 'svg_scene' }>;

function safeValue(name:string,value:unknown,prefix:string,defIds:Set<string>): string|number|undefined {
  if(value==null)return undefined;
  if(validateSvgAttrValue(name,value,defIds))throw Error('図形の属性が無効です。');
  const ref=typeof value==='string'&&svgLocalRef.exec(value.trim());
  return ref ? 'url(#'+prefix+'-'+ref[1]+')' : value as string|number;
}

export function renderSvgScene(node:Scene,context:RichEvalContext,cycle:RenderCycle,prefix:string,dispatch:(a:RichStateAction[],c:RichEvalContext)=>void):React.ReactNode{
  const defs=node.defs??[];
  const defIds=new Set(defs.map(d=>d.id));
  if (!validSvgViewBox(node.viewBox) || defIds.size !== defs.length || !defs.every(isSvgDefinition) ||
      !svgRoleMatchesActions(node.interactiveRole,node.elements)) throw Error('図形の定義が無効です。');
  const v=<T,>(value:T|{expr:string}|undefined,c=context)=>evaluate<T>(value,c,cycle);
  const attr=(name:string,value:unknown,c=context)=>safeValue(name,v(value as string|number|{expr:string},c),prefix,defIds);
  const attributes=(values:Record<string,unknown>|undefined,c:RichEvalContext)=>{
    const out:Record<string,string|number>={};
    for(const [name,raw]of Object.entries(values??{})){
      if(!SVG_ATTRS.has(name))throw Error('図形の属性が無効です。');
      const resolved=attr(name,raw,c);if(resolved!==undefined)out[name]=resolved;
    }return out;
  };
  function definition(d:RichSvgDef){
    for(let i=0;i<svgDefinitionElementCount(d);i++)addNode(cycle,true);
    const id=prefix+'-'+d.id;
    if(d.kind==='linearGradient'||d.kind==='radialGradient'){
      const tag=d.kind;const position=d.kind==='linearGradient'?{x1:attr('x1',d.x1),y1:attr('y1',d.y1),x2:attr('x2',d.x2),y2:attr('y2',d.y2)}:{cx:attr('cx',d.cx),cy:attr('cy',d.cy),r:attr('r',d.r)};
      return React.createElement(tag,{key:id,id,...position},d.stops.map((s,i)=><stop key={i} offset={attr('offset',s.offset)} stopColor={attr('stopColor',s.color) as string | undefined} stopOpacity={attr('opacity',s.opacity)}/>));
    }
    if(d.kind==='marker')return <marker key={id} id={id} viewBox={d.viewBox} refX={d.refX} refY={d.refY} markerWidth={d.markerWidth} markerHeight={d.markerHeight} orient={d.orient}><path d={attr('d',d.pathD) as string} fill={attr('fill',d.fill) as string | undefined}/></marker>;
    if(d.kind==='clipPath'&&['rect','circle','polygon'].includes(d.shape))return <clipPath key={id} id={id}>{React.createElement(d.shape,attributes(d.attrs,context))}</clipPath>;
    throw Error('図形の定義が無効です。');
  }
  function render(el:RichSvgElement,c:RichEvalContext,key:string,repeat=true):React.ReactNode{
    if(repeat&&el.repeat)return repeatContexts(el.repeat,c,cycle).map(r=>render(el,r.context,key+':'+r.key,false));
    if(el.visibleWhen&&!expression(el.visibleWhen,c,cycle))return null;
    addNode(cycle,true);
    if(!SVG_TAGS.has(el.tag))throw Error('図形の種類が無効です。');
    const interactive=node.interactiveRole==='interactive'&&Boolean(el.onClick?.length);
    const props={...attributes(el.attrs,c),key,...(el.id?{'data-rich-svg-element':el.id}:{}),...(interactive?{
      role:'button',tabIndex:0,'aria-label':text(v(el.tooltip,c),text(v(el.textContent,c),el.id??'図形')),
      onClick:(e:React.MouseEvent)=>{e.stopPropagation();dispatch(el.onClick!,c)},
      onKeyDown:(e:React.KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.stopPropagation();e.preventDefault();dispatch(el.onClick!,c)}},
    }:{})};
    return React.createElement(el.tag,props,el.tooltip?<title>{text(v(el.tooltip,c))}</title>:null,text(v(el.textContent,c)),el.children?.map((child,i)=>render(child,c,key+':'+i)));
  }
  const label=text(v(node.title),node.interactiveRole==='interactive'?'操作可能な図':node.interactiveRole==='wireframe'?'ワイヤーフレーム':'図');
  return <svg className="rich-svg-scene" viewBox={node.viewBox} role={node.interactiveRole==='interactive'?'group':'img'} aria-label={label}
    data-diagram-role={node.interactiveRole??'diagram'} style={{width:'100%',maxHeight:600,aspectRatio:node.aspectRatio&&/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(node.aspectRatio)?node.aspectRatio:undefined}}>
    <title>{label}</title><defs>{defs.map(definition)}</defs>{node.elements.map((el,i)=>render(el,context,String(i)))}
  </svg>;
}
