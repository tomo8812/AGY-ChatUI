import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { RichDocumentV1, RichNode, RichLayoutProps, RichAction, RichStateAction, RichSourceEntry, RichCellObject, RichPrimitive } from '../../../../shared/rich-schema';
import type { ArtifactRecord } from '../../types';
import { buildArtifactContentUrl } from '../../utils/viewerCache';
import { MarkdownContent, MermaidBlock, CodeBlock } from '../MarkdownContent';
import { CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileIcon, SearchIcon, SettingsIcon, PlusIcon, CloseIcon, FolderIcon, GaugeIcon, ShieldIcon } from '../Icons';
import { createRichEvalBudget, isValidHttpUrl, validateRichMarkdownContent, parseRichExpr, type ExprAst, type RichEvalContext } from './RichExprEvaluator';
import { RichStateStore, type RichStateSnapshot } from './RichStateStore';
import { runExplicitRichActions, type RichActionHost } from './RichActionRunner';
import { addNode, color, evaluate, expression, num, repeatContexts, safeArray, text, type RenderCycle, type SelectValue } from './runtime';
import { renderRichChart } from './chart/RichChartRenderer';
import { renderSvgScene } from './diagram/SvgSceneRenderer';
import { renderNodeEdgeDiagram } from './diagram/NodeEdgeDiagram';
import { RichDataTable } from './display/RichDataTable';
import './rich-ui.css';

type ArtifactHost = Omit<RichActionHost,'authorizeArtifact'>;
export interface RichRendererProps {
  document: RichDocumentV1;
  userId: string;
  chatId: string;
  artifacts?: readonly ArtifactRecord[];
  actions?: ArtifactHost;
}
const noArtifacts:readonly ArtifactRecord[]=[];
const noActions:ArtifactHost={};
const icons={check:CheckIcon,copy:CopyIcon,download:DownloadIcon,link:ExternalLinkIcon,file:FileIcon,search:SearchIcon,settings:SettingsIcon,plus:PlusIcon,x:CloseIcon,folder:FolderIcon,gauge:GaugeIcon,shield:ShieldIcon};
const space={none:0,xs:4,sm:8,md:12,lg:20};
function finiteBound(value:unknown,min:number,max:number,fallback:number){return Math.min(max,Math.max(min,num(value,fallback)))}
function styleLayout(layout:RichLayoutProps|undefined):CSSProperties{
  if(!layout)return {};
  const span=typeof layout.span==='number'?{pc:layout.span,mobile:layout.span}:layout.span;
  const align=layout.align==='start'?'flex-start':layout.align==='end'?'flex-end':layout.align;
  const justify=layout.justify==='between'?'space-between':layout.justify==='around'?'space-around':layout.justify==='start'?'flex-start':layout.justify==='end'?'flex-end':layout.justify;
  return {
    '--rich-span-pc':finiteBound(span?.pc,1,12,1),'--rich-span-mobile':finiteBound(span?.mobile,1,12,1),
    ...(layout.gap!==undefined?{gap:space[layout.gap]}:{}),...(layout.padding!==undefined?{padding:space[layout.padding]}:{}),
    alignItems:align,justifyContent:justify,
    ...(layout.minWidthPx!==undefined?{minWidth:'min(100%, '+finiteBound(layout.minWidthPx,0,1200,0)+'px)'}:{}),
    ...(layout.maxWidthPx!==undefined?{maxWidth:finiteBound(layout.maxWidthPx,0,1600,1600)}:{}),
    ...(layout.grow!==undefined?{flexGrow:finiteBound(layout.grow,0,12,0)}:{}),
    ...(layout.shrink!==undefined?{flexShrink:finiteBound(layout.shrink,0,12,1)}:{}),
    ...(layout.wrap!==undefined?{flexWrap:layout.wrap?'wrap':'nowrap'}:{}),
  } as CSSProperties;
}
const toneClass=(tone:unknown)=>['muted','info','success','warning','danger'].includes(String(tone))?' rich-tone-'+String(tone):'';
function SourceAttribution({sources}:{sources:RichSourceEntry[]}){
  return <div className="rich-sources">{sources.map(s=><div key={s.id} className="rich-source"><span className="rich-source-id">{s.id}</span>
    {s.url&&isValidHttpUrl(s.url)?<a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a>:<span>{s.name}</span>}
    <small>{[s.asOf&&'基準 '+s.asOf,s.fetchedAt&&'取得 '+s.fetchedAt,s.timezone,s.unit,s.currency,s.period,s.valueStatus,s.delayNotice].filter(Boolean).join(' · ')}</small></div>)}</div>;
}
function Tabs({items,value,onChange}:{items:Array<{id:string;label:string;badge:string;content:ReactNode}>;value?:string;onChange?:(id:string)=>void}){
  const [local,setLocal]=useState(items[0]?.id??'');
  const active=items.some(i=>i.id===(value??local))?(value??local):items[0]?.id;
  const id=useId();
  const choose=(next:string)=>{if(onChange)onChange(next);else setLocal(next)};
  return <div><div className="rich-tabs" role="tablist">{items.map((i,n)=><button key={i.id} type="button" role="tab" id={id+'-tab-'+n} aria-controls={id+'-panel-'+n} aria-selected={active===i.id} tabIndex={active===i.id?0:-1}
    onClick={()=>choose(i.id)} onKeyDown={e=>{let next=n;if(e.key==='ArrowRight')next=(n+1)%items.length;else if(e.key==='ArrowLeft')next=(n+items.length-1)%items.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=items.length-1;else return;e.preventDefault();choose(items[next].id);document.getElementById(id+'-tab-'+next)?.focus()}}>{i.label}{i.badge&&<small>{i.badge}</small>}</button>)}</div>
    {items.map((i,n)=><div key={i.id} hidden={active!==i.id} role="tabpanel" id={id+'-panel-'+n} aria-labelledby={id+'-tab-'+n}>{i.content}</div>)}
  </div>;
}
function Collapsible({title,open,defaultOpen,onChange,children}:{title:string;open?:boolean;defaultOpen?:boolean;onChange?:(open:boolean)=>void;children:ReactNode}){
  const [local,setLocal]=useState(Boolean(defaultOpen));const expanded=open??local;const id=useId();
  return <div className="rich-collapsible"><button type="button" className="btn btn-ghost" aria-expanded={expanded} aria-controls={id} onClick={()=>onChange?onChange(!expanded):setLocal(!expanded)}>{expanded?'▾':'▸'} {title}</button><div id={id} hidden={!expanded}>{children}</div></div>;
}
function useTheme(){const read=()=>typeof document!=='undefined'&&document.documentElement.dataset.theme==='dark'?'dark' as const:'light' as const;return useSyncExternalStore(callback=>{const observer=new MutationObserver(callback);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect()},read,()=> 'light' as const)}
export class BlockErrorBoundary extends React.Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed?<div className="error-box" role="alert">このコンテンツを表示できません。</div>:this.props.children}
}
type LocalContext=Pick<RichEvalContext,'item'|'index'|'aliases'>;
const emptyLocal:LocalContext={};
type NodeEnvironment={
  store:RichStateStore;doc:RichDocumentV1;authorized:Map<string,ArtifactRecord>;prefix:string;host:RichActionHost;
  fail:()=>void;dispatch:(a:RichStateAction[],c:RichEvalContext)=>void;select:SelectValue;
  explicit:(a:readonly RichAction[],c:RichEvalContext)=>void;
};
function expressionKeys(expr:string,keys:Set<string>){
  function walk(ast:ExprAst){
    switch(ast.kind){
      case 'ident':
        if(ast.name==='$state')keys.add('state:*');
        else if(ast.name==='$computed')keys.add('computed:*');
        else if(ast.name==='$theme')keys.add('theme');
        break;
      case 'member':
        if(ast.object.kind==='ident'&&['$state','$computed'].includes(ast.object.name))keys.add(ast.object.name.slice(1)+':'+ast.property);
        else walk(ast.object);
        break;
      case 'index':
        if(ast.object.kind==='ident'&&['$state','$computed'].includes(ast.object.name)&&ast.index.kind==='literal'&&typeof ast.index.value==='string')keys.add(ast.object.name.slice(1)+':'+ast.index.value);
        else walk(ast.object);
        walk(ast.index);break;
      case 'unary':walk(ast.operand);break;
      case 'binary':walk(ast.left);walk(ast.right);break;
      case 'ternary':walk(ast.condition);walk(ast.consequent);walk(ast.alternate);break;
      case 'call':ast.args.forEach(walk);break;
      case 'array':ast.items.forEach(walk);break;
    }
  }
  try{walk(parseRichExpr(expr))}catch{keys.add('state:*');keys.add('computed:*');keys.add('theme')}
}
/** Children subscribe independently; SVG internals and chart series belong to
 * the node that paints them. Whole-record or dynamic indices stay conservative. */
export function richNodeProjection(node:RichNode,repeat=true):string[]{
  const keys=new Set<string>();
  const visit=(value:unknown,field:string)=>{
    if(typeof value==='string'){
      if(field==='expr'||field.endsWith('Expr')||field.endsWith('When'))expressionKeys(value,keys);
      else if(['bind','bindKey','selectedRowBind','selectedNodeBind','selectedPointBind'].includes(field))keys.add('state:'+value);
    }else if(Array.isArray(value))value.forEach(v=>visit(v,''));
    else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>visit(v,k));
  };
  for(const [k,v] of Object.entries(node)){
    if(['children','headerAction','footer','trigger'].includes(k)||k==='repeat'&&!repeat)continue;
    if((node.type==='popover'||node.type==='tooltip')&&k==='content'&&Array.isArray(v))continue;
    if(node.type==='tabs'&&k==='items'){for(const item of node.items){visit(item.label,'label');visit(item.badge,'badge')}continue}
    visit(v,k);
  }
  return [...keys].sort();
}
function projectionEqual(a:RichStateSnapshot,b:RichStateSnapshot,keys:readonly string[]){
  return keys.every(key=>{
    if(key==='theme')return a.theme===b.theme;
    const split=key.indexOf(':'),group=key.slice(0,split)==='state'?'state':'computed',name=key.slice(split+1);
    if(name==='*')return Object.keys(a[group]).length===Object.keys(b[group]).length&&Object.keys(a[group]).every(k=>Object.is(a[group][k],b[group][k]));
    return Object.is(a[group][name],b[group][name]);
  });
}
function useProjection(store:RichStateStore,keys:readonly string[]){
  const selector=useMemo(()=>{
    let cached=store.getSnapshot();
    return {subscribe:(listener:()=>void)=>store.subscribeProjection(keys,listener),
      get:()=>{const current=store.getSnapshot();if(!projectionEqual(cached,current,keys))cached=current;return cached}};
  },[store,keys]);
  return useSyncExternalStore(selector.subscribe,selector.get,selector.get);
}
function RichTitle({value,store}:{value:RichDocumentV1['title'];store:RichStateStore}){
  const keys=useMemo(()=>{const set=new Set<string>();if(value&&typeof value==='object'&&'expr' in value)expressionKeys(String(value.expr),set);return [...set]},[value]);
  useProjection(store,keys);
  return value?<div className="rich-document-title">{text(evaluate(value,store.context(),{budget:createRichEvalBudget(),nodes:0,svgElements:0}))}</div>:null;
}
function RichRendererInner({document:doc,userId,chatId,artifacts=noArtifacts,actions=noActions}:RichRendererProps){
  const theme=useTheme();
  const authorized=useMemo(()=>new Map(artifacts.filter(a=>a.userId===userId&&a.chatId===chatId).map(a=>[a.id,a])),[artifacts,userId,chatId]);
  // Revision changes to an authorized file must not reset unrelated local control state.
  const authKey=JSON.stringify([...authorized.keys()].sort());
  const docKey=JSON.stringify(doc);
  const store=useMemo(()=>new RichStateStore(JSON.parse(docKey) as RichDocumentV1,JSON.parse(authKey) as string[],theme),[docKey,authKey,userId,chatId]);
  const [error,setError]=useState<string|null>(null);
  const activeAction=useRef<AbortController|null>(null);
  const latestAuthorization=useRef(authorized);latestAuthorization.current=authorized;
  useEffect(()=>()=>{activeAction.current?.abort();activeAction.current=null},[store]);
  useEffect(()=>{try{store.setTheme(theme)}catch{setError('テーマ変更を適用できませんでした。')}},[theme,store]);
  const prefix=useId().replace(/[^a-zA-Z0-9_-]/g,'');
  const environment=useMemo<NodeEnvironment>(()=>{
  const host:RichActionHost={...actions,authorizeArtifact:id=>latestAuthorization.current.has(id)};
  const fail=()=>setError('操作を適用できませんでした。');
  const dispatch=(a:RichStateAction[],c:RichEvalContext)=>{try{store.dispatch(a,c);setError(null)}catch{fail()}};
  const select:SelectValue=(bind,value,a,c)=>{try{if(bind)store.set(bind,value,a,c);else if(a?.length)store.dispatch(a,c);setError(null)}catch{fail()}};
  const explicit=(a:readonly RichAction[],c:RichEvalContext)=>{
    if(activeAction.current)return;
    const controller=new AbortController();activeAction.current=controller;setError(null);
    void runExplicitRichActions(a,store,c,host,controller.signal).catch(()=>{if(!controller.signal.aborted)fail()}).finally(()=>{if(activeAction.current===controller)activeAction.current=null});
  };
  return {store,doc,authorized,prefix,host,fail,dispatch,select,explicit};
  },[store,doc,authorized,prefix,actions]);
  return <section className="rich-document"><RichTitle value={doc.title} store={store}/>{error&&<div className="error-box" role="alert">{error}<button className="btn btn-ghost btn-xs" type="button" onClick={()=>setError(null)}>閉じる</button></div>}<RichNodeView node={doc.root} local={emptyLocal} path="root" environment={environment}/></section>;
}
const RichNodeView=React.memo(function RichNodePaint({node,local,path,environment,repeat=true}:{node:RichNode;local:LocalContext;path:string;environment:NodeEnvironment;repeat?:boolean}){
  const {store,doc,authorized,prefix,host,fail,dispatch,select,explicit}=environment;
  const keys=useMemo(()=>richNodeProjection(node,repeat),[node,repeat]);
  const heavy=['chart','svg_scene','node_edge_diagram','mermaid'].includes(node.type)&&!node.visibleWhen&&!(repeat&&node.repeat);
  const paintRef=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    if(!heavy||!paintRef.current||typeof IntersectionObserver==='undefined')return;
    const element=paintRef.current;
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting||element.contains(document.activeElement)),{rootMargin:'200px'});
    observer.observe(element);return()=>observer.disconnect();
  },[heavy]);
  const pausedKeys=useMemo<string[]>(()=>[],[]);
  useProjection(store,heavy&&!visible?pausedKeys:keys);
  // RichStateStore validates the entire expanded document atomically, including
  // global limits, before publishing. Keep a bounded evaluator for each paint.
  const cycle:RenderCycle={budget:createRichEvalBudget(),nodes:0,svgElements:0};
  const c=store.context(local.item,local.index,local.aliases);
  const source=(id:string|undefined,asOf?:string,fetchedAt?:string)=>{
    const s=doc.sources?.find(x=>x.id===id);
    return [s?.name??id,asOf??s?.asOf,fetchedAt??s?.fetchedAt].filter(Boolean).join(' · ');
  };
    const renderNode=(child:RichNode,_context:RichEvalContext,childPath:string)=><RichNodeView node={child} local={local} path={childPath} environment={environment}/>;
    if(repeat&&node.repeat)return <>{repeatContexts(node.repeat,c,cycle).map(r=><RichNodeView key={r.key} node={node} local={{item:r.context.item,index:r.context.index,aliases:r.context.aliases}} path={path+'-'+r.key} environment={environment} repeat={false}/>)}</>;
    if(node.visibleWhen&&!expression(node.visibleWhen,c,cycle))return null;
    addNode(cycle);
    const v=<T,>(x:T|{expr:string}|undefined)=>evaluate<T>(x,c,cycle);
    const label=(x:unknown)=>text(x);
    const read=(key:string)=>c.state[key];
    const change=(bind:string,value:unknown,a?:RichStateAction[])=>select(bind,value,a,c);
    const children=(nodes:RichNode[]|undefined,suffix='children')=>nodes?.map((n,i)=><React.Fragment key={n.id}>{renderNode(n,c,path+'-'+suffix+'-'+i)}</React.Fragment>);
    const unique=prefix+'-'+Array.from(path,c=>c.codePointAt(0)!.toString(16)).join('-');
    let body:ReactNode;
    switch(node.type){
      case 'stack':{
        const direction=typeof node.direction==='string'?{pc:node.direction,mobile:node.direction}:node.direction;
        body=<div className={'rich-stack rich-stack-pc-'+direction.pc+' rich-stack-mobile-'+direction.mobile} style={styleLayout(node.layout)}>{children(node.children)}</div>;break;
      }
      case 'grid':{
        const columns=typeof node.columns==='number'?{pc:node.columns,mobile:Math.min(2,node.columns)}:node.columns;
        const style=columns==='auto-fit'?{gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,'+finiteBound(node.minColWidthPx,100,600,180)+'px),1fr))'}:{'--rich-cols-pc':finiteBound(columns.pc,1,12,2),'--rich-cols-mobile':finiteBound(columns.mobile,1,12,1)};
        body=<div className="rich-grid" style={{...styleLayout(node.layout),...style} as CSSProperties}>{children(node.children)}</div>;break;
      }
      case 'columns': body=<div className={'rich-columns'+(node.keepRowOnMobile?' rich-keep-row':'')} style={{...styleLayout(node.layout),'--rich-columns':node.children.map((_,i)=>'minmax(0,'+finiteBound(node.ratios?.[i],0.1,20,1)+'fr)').join(' ')} as CSSProperties}>{children(node.children)}</div>;break;
      case 'container':case 'card':body=<section className={'rich-panel rich-panel-'+(node.variant??'default')} style={styleLayout(node.layout)}>{node.type==='card'&&<>{(node.title||node.headerAction)&&<div className="rich-card-header"><strong>{label(v(node.title))}</strong>{node.headerAction&&renderNode(node.headerAction,c,path+'-header')}</div>}{node.subtitle&&<div className="muted-sm">{label(v(node.subtitle))}</div>}</>}{children(node.children)}{node.type==='card'&&node.footer&&renderNode(node.footer,c,path+'-footer')}</section>;break;
      case 'responsive_box':body=<div className="rich-responsive-box" style={{...styleLayout(node.layout),'--rich-padding-pc':space[node.pc?.padding??'none']+'px','--rich-padding-mobile':space[node.mobile?.padding??'none']+'px','--rich-gap-pc':space[node.pc?.gap??'sm']+'px','--rich-gap-mobile':space[node.mobile?.gap??'sm']+'px'} as CSSProperties}>{children(node.children)}</div>;break;
      case 'scroll_area':body=<div className="rich-scroll-area" style={{maxHeight:finiteBound(node.maxHeightPx,80,1200,400),overflowX:node.axis==='y'?'hidden':'auto',overflowY:node.axis==='x'?'hidden':'auto'}}>{children(node.children)}</div>;break;
      case 'carousel':body=<div className="rich-carousel" style={{'--rich-carousel-width':finiteBound(node.itemMinWidthPx,120,500,220)+'px'} as CSSProperties}>{children(node.children)}</div>;break;
      case 'divider':body=<div role="separator" className={'rich-divider '+(node.orientation==='vertical'?'vertical':'')}>{node.label&&<span>{label(v(node.label))}</span>}</div>;break;
      case 'spacer':body=<div aria-hidden="true" style={{height:space[node.size]}}/>;break;
      case 'text':case 'caption':case 'note':case 'quote':case 'emphasis':{
        const Tag=node.type==='quote'?'blockquote':node.type==='emphasis'?'strong':node.type==='caption'?'small':'div';
        body=<Tag className={'rich-'+node.type+toneClass(node.tone)+(node.mono?' rich-mono':'')} style={{textAlign:node.align}}>{label(v(node.content))}</Tag>;break;
      }
      case 'heading':{const Tag=([1,2,3,4].includes(node.level)?'h'+node.level:'h3') as 'h1'|'h2'|'h3'|'h4';body=<Tag className={'rich-heading'+toneClass(node.tone)}>{label(v(node.content))}</Tag>;break}
      case 'markdown':{const content=label(v(node.content));if(validateRichMarkdownContent(content))throw Error('表示できない文書です。');body=<MarkdownContent content={content} strictRich/>;break}
      case 'icon':{const Icon=Object.prototype.hasOwnProperty.call(icons,node.name)?icons[node.name as keyof typeof icons]:null;body=Icon?<span aria-hidden={node.decorative===true} aria-label={node.decorative?undefined:label(v(node.ariaLabel))||node.name} role={node.decorative?undefined:'img'} className={toneClass(node.tone)}><Icon size={node.size==='lg'?24:node.size==='sm'?14:18}/></span>:<span className="muted-xs">{node.name}</span>;break}
      case 'badge':case 'status':body=<span className={'rich-status'+toneClass(node.tone)}>{node.dot&&<i/>}{label(v(node.label))}</span>;break;
      case 'stat':case 'kpi_card':{const value=v(node.value);body=<div className={'rich-kpi'+(node.type==='stat'?' plain':'')}><span className="muted-sm">{label(v(node.label))}</span><div className="rich-kpi-value">{value==null?node.missingLabel??'—':label(value)}{value!=null&&node.unit&&<small> {label(v(node.unit))}</small>}</div>{value==null&&node.missingReason&&<small>{label(v(node.missingReason))}</small>}{node.delta&&<span className={v(node.deltaTone)==='positive'?'rich-tone-success':v(node.deltaTone)==='negative'?'rich-tone-danger':''}>{label(v(node.delta))}</span>}<small className="rich-cell-meta">{source(node.sourceId,label(v(node.asOf))||undefined,label(v(node.fetchedAt))||undefined)}</small>{children(node.children)}</div>;break}
      case 'progress':{const max=Math.max(0.00001,num(v(node.max),100)),value=Math.min(max,Math.max(0,num(v(node.value),0)));body=<label className={'rich-progress'+toneClass(node.tone)}><span>{label(v(node.label))}{node.showPercent&&' '+Math.round(value/max*100)+'%'}</span><progress max={max} value={value}/></label>;break}
      case 'list':case 'checklist':case 'steps':case 'timeline':{
        const items=safeArray<{id?:string;title:string;description?:string;meta?:string;checked?:boolean;status?:string;sourceId?:string;asOf?:string}>(v(node.items));
        const selected=node.bindKey&&Array.isArray(read(node.bindKey))?read(node.bindKey) as unknown[]:undefined;
        const Tag=node.type==='steps'?'ol':'ul';
        body=<Tag className={'rich-list rich-list-'+node.type}>{items.map((item,i)=>{const itemId=item.id??String(i);const checked=selected?selected.includes(itemId):Boolean(item.checked);return <li key={itemId}><div className="rich-list-row">{node.type==='checklist'&&(node.bindKey?<input type="checkbox" aria-label={item.title} checked={checked} onChange={e=>{const current=(selected??items.map((x,j)=>x.checked?x.id??String(j):null).filter(x=>x!==null));change(node.bindKey!,e.target.checked?[...current,itemId]:current.filter(x=>x!==itemId))}}/>:<span aria-hidden="true">{checked?'✓':'○'}</span>)}<div><strong>{item.title}</strong>{item.description&&<div>{item.description}</div>}<small className="rich-cell-meta">{[item.meta,item.status,source(item.sourceId,item.asOf)].filter(Boolean).join(' · ')}</small></div></div></li>})}{children(node.children)}</Tag>;break;
      }
      case 'data_table':{const rows=safeArray<Record<string,RichPrimitive|RichCellObject>>(v(node.rows));body=<RichDataTable node={node} rows={rows} onSelect={node.selectedRowBind||node.onRowSelect?.length?(row,index)=>select(node.selectedRowBind,index,node.onRowSelect,{...c,item:row,index}):undefined}/>;break}
      case 'source_attribution':body=<SourceAttribution sources={(doc.sources??[]).filter(s=>!node.sourceIds||node.sourceIds.includes(s.id))}/>;break;
      case 'mermaid':body=<MermaidBlock code={label(v(node.code))} strictRich/>;break;
      case 'svg_scene':body=renderSvgScene(node,c,cycle,unique,dispatch);break;
      case 'node_edge_diagram':body=renderNodeEdgeDiagram(node,c,cycle,select,unique);break;
      case 'chart':body=renderRichChart({node,context:c,cycle,select,clipId:unique+'-clip'});break;
      case 'button':body=<button type="button" className={'btn btn-'+(node.variant==='danger'?'danger-outline':node.variant??'secondary')} disabled={Boolean(node.disabledWhen&&expression(node.disabledWhen,c,cycle))} onClick={()=>explicit(node.onClick,c)}>{label(v(node.label))}</button>;break;
      case 'clickable':case 'selectable_card':{const selected=Boolean(node.selectedWhen&&expression(node.selectedWhen,c,cycle));body=<div className={'rich-selectable'+(selected?' selected':'')} role="button" tabIndex={0} aria-pressed={selected} onClick={e=>{if(!(e.target as HTMLElement).closest('button,input,select,textarea,a,[role=button]:not(.rich-selectable)'))dispatch(node.onClick,c)}} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();dispatch(node.onClick,c)}}}>{children(node.children)}</div>;break}
      case 'text_input':case 'textarea':case 'date_input':{const val=label(read(node.bind));const common={value:val,onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>change(node.bind,e.target.value,node.onChange)};body=<label className="field">{label(v(node.label))}{node.type==='textarea'?<textarea rows={4} maxLength={node.maxLength??50000} placeholder={node.placeholder} {...common}/>:node.type==='date_input'?<input type="date" min={node.min} max={node.max} {...common}/>:<input type="text" maxLength={node.maxLength??50000} placeholder={node.placeholder} {...common}/>}</label>;break}
      case 'number_input':case 'slider':{const min=num(v(node.min),0),max=Math.max(min,num(v(node.max),100)),step=Math.max(0.000001,num(v(node.step),1));const value=num(read(node.bind),min);body=<label className="field"><span>{label(v(node.label))}{node.type==='slider'&&<output> {value}{node.unit??''}</output>}</span><input type={node.type==='slider'?'range':'number'} value={value} min={min} max={max} step={step} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value))change(node.bind,Math.min(max,Math.max(min,value)),node.onChange)}}/></label>;break}
      case 'checkbox':case 'toggle':body=<label className="rich-checkbox"><input type="checkbox" role={node.type==='toggle'?'switch':undefined} checked={Boolean(read(node.bind))} onChange={e=>change(node.bind,e.target.checked,node.onChange)}/>{label(v(node.label))}</label>;break;
      case 'radio_group':case 'select':case 'segmented':{const options=safeArray<{value:string|number;label:string;disabled?:boolean}>(v(node.options));const index=options.findIndex(o=>Object.is(o.value,read(node.bind)));body=node.type==='select'?<label className="field">{label(v(node.label))}<select className="compact-select" value={String(index)} onChange={e=>{const o=options[Number(e.target.value)];if(o&&!o.disabled)change(node.bind,o.value,node.onChange)}}>{index<0&&<option value="-1" disabled>選択してください</option>}{options.map((o,i)=><option key={i} value={i} disabled={o.disabled}>{o.label}</option>)}</select></label>:<fieldset className={'rich-options '+node.type}><legend>{label(v(node.label))}</legend>{options.map((o,i)=><label key={i} className={index===i?'selected':''}><input name={unique} type="radio" checked={i===index} disabled={o.disabled} onChange={()=>change(node.bind,o.value,node.onChange)}/>{o.label}</label>)}</fieldset>;break}
      case 'tabs':body=<Tabs items={node.items.map((item,i)=>({id:item.id,label:label(v(item.label)),badge:label(v(item.badge)),content:children(item.content,'tab-'+i)}))} value={node.bind?label(read(node.bind)):undefined} onChange={node.bind?id=>change(node.bind!,id):undefined}/>;break;
      case 'collapsible':body=<Collapsible title={label(v(node.title))} open={node.bind?Boolean(read(node.bind)):undefined} defaultOpen={node.defaultOpen} onChange={node.bind?open=>change(node.bind!,open):undefined}>{children(node.children)}</Collapsible>;break;
      case 'popover':case 'tooltip':body=<details className="rich-collapsible"><summary>{renderNode(node.trigger,c,path+'-trigger')}</summary>{Array.isArray(node.content)?children(node.content):label(v(node.content))}</details>;break;
      case 'form':body=<form className="rich-form" onSubmit={e=>{e.preventDefault();explicit(node.onSubmit,c)}}>{children(node.children)}<button className="btn btn-primary" type="submit">送信</button></form>;break;
      case 'editable_draft':body=<div className="rich-form"><label className="field">{label(v(node.label))}<textarea rows={6} value={label(read(node.bind))} onChange={e=>change(node.bind,e.target.value)}/></label>{node.format==='markdown'&&<MarkdownContent content={label(read(node.bind))} strictRich/>}{node.saveAction&&<button type="button" className="btn btn-secondary" onClick={()=>explicit([node.saveAction!],c)}>ファイルに保存</button>}</div>;break;
      case 'code_block':body=<CodeBlock code={label(v(node.code))} language={node.language??''}/>;break;
      case 'diff_block':body=<div className="rich-diff"><div><span className="muted-sm">変更前</span><CodeBlock code={label(v(node.oldText))} language={node.language??''}/></div><div><span className="muted-sm">変更後</span><CodeBlock code={label(v(node.newText))} language={node.language??''}/></div></div>;break;
      case 'math_block':{const tex=label(v(node.tex));body=<MarkdownContent strictRich content={node.displayMode===false?'$'+tex+'$':'$$\n'+tex+'\n$$'}/>;break}
      case 'media_asset':{const alt=label(v(node.alt));let media:ReactNode;if(node.sourceKind==='inline_svg'&&node.svgScene)media=renderSvgScene(node.svgScene,c,cycle,unique,dispatch);else{const artifact=authorized.get(label(v(node.artifactId)));if(!artifact)throw Error('ファイルを表示できません。');const src=buildArtifactContentUrl(artifact);media=artifact.previewKind==='image'||artifact.previewKind==='svg'?<img alt={alt} src={src} loading="lazy"/>:artifact.previewKind==='video'?<video controls playsInline preload="metadata" src={src} aria-label={alt}/>:artifact.previewKind==='audio'?<audio controls preload="metadata" src={src} aria-label={alt}/>:<button type="button" className="btn btn-secondary" disabled={!host.openArtifact} onClick={()=>{void Promise.resolve(host.openArtifact?.(artifact.id)).catch(fail)}}>{artifact.filename}</button>}body=<figure className="rich-media">{media}{node.caption&&<figcaption>{label(v(node.caption))}</figcaption>}</figure>;break}
      default:body=<div className="error-box">この項目は表示できません。</div>;
    }
    return <div ref={heavy?paintRef:undefined} onFocusCapture={heavy?()=>setVisible(true):undefined} className={'rich-node'+(node.layout?.hideOn?' rich-hide-'+node.layout.hideOn:'')} style={styleLayout(node.layout)} data-rich-node-id={node.id} aria-label={node.ariaLabel?label(v(node.ariaLabel)):undefined}>{body}</div>;
});

export function RichRenderer(props:RichRendererProps){
  return <BlockErrorBoundary key={props.userId+':'+props.chatId+':'+JSON.stringify(props.document)}><RichRendererInner {...props}/></BlockErrorBoundary>;
}
