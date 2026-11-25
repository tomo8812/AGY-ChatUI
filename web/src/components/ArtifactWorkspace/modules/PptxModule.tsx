import React,{useEffect,useRef,useState} from 'react';
import { workspaceApi,supportsOperation,type EditOperation } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { PdfCanvasViewer } from '../../shared-ui/document/PdfCanvasCore';
import { artifactVersionKey, buildArtifactContentUrl } from '../../../utils/viewerCache';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
type Slide={id:string;part:string};
type Bounds={x:number;y:number;width:number;height:number};
type Shape={id:string;name:string;type:string;text:string;zOrder:number;transform?:{geomBoundsPt?:Bounds;rotationDegrees?:number}};
type Presentation={slides:Slide[];layouts?:{part:string;name:string;type:string}[];slideSize:{widthPt:number;heightPt:number}};
type SlideData={slideId:string;shapes:Shape[];background:Blob;layers:{shape:Shape;image:Blob}[]};
function useImage(blob:Blob|undefined){
  const [image,setImage]=useState<{blob:Blob;url:string}|null>(null);
  useEffect(()=>{if(!blob){setImage(null);return}const u=URL.createObjectURL(blob);setImage({blob,url:u});return()=>URL.revokeObjectURL(u)},[blob]);
  return image?.blob===blob?image?.url??'':'';
}
function Layer({blob,style,alt=''}:{blob:Blob;style?:React.CSSProperties;alt?:string}){
  const url=useImage(blob);return url?<img className="workspace-slide-layer" draggable={false} src={url} style={style} alt={alt}/>:null;
}
function MiniSlide({artifact,index,active,onClick,disabled}:{artifact:WorkspaceModuleProps['artifact'];index:number;active:boolean;onClick:()=>void;disabled?:boolean}){
  const r=useRevisionResource(artifact,'thumb:'+index,signal=>workspaceApi.render(artifact,{pageIndex:index},signal));
  const url=useImage(r.ready?r.data??undefined:undefined);
  return <button type="button" className={'workspace-slide-nav-item '+(active?'active':'')} aria-label={'スライド '+(index+1)} aria-pressed={active} disabled={disabled} onClick={onClick}>{url?<img src={url} alt=""/>:<span> {index+1} </span>}<small>{index+1}</small></button>;
}
/** Match the native draft renderer: text and geometry precede styling. */
export function preparePptxOperations(operations:readonly EditOperation[]):EditOperation[]{
  return [...operations].sort((a,b)=>Number(a.op==='pptx.set_shape_style')-Number(b.op==='pptx.set_shape_style'));
}
export function PptxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,target}:WorkspaceModuleProps){
  const [slideId,setSlideId]=useState('');
  const [selected,setSelected]=useState('');
  const [operationKind,setOperationKind]=useState('');
  const [shapeText,setShapeText]=useState('');
  const [shapeKind,setShapeKind]=useState<'rectangle'|'ellipse'|'textbox'>('rectangle');
  const [newBounds,setNewBounds]=useState<[number,number,number,number]>([10,10,120,60]);
  const [newRows,setNewRows]=useState([['',''],['','']]);
  const [layoutPart,setLayoutPart]=useState('');
  const [destination,setDestination]=useState(1);
  const [fileData,setFileData]=useState<{name:string;base64:string}|null>(null);
  const [operationError,setOperationError]=useState('');
  const fileGeneration=useRef(0);
  const pendingNavigation=useRef<{revision:number;index:number}|null>(null);
  const [drag,setDrag]=useState<{id:string;dx:number;dy:number}|null>(null);
  const [resize,setResize]=useState<{id:string;bounds:Bounds}|null>(null);
  const resizePointer=useRef<{id:string;x:number;y:number;bounds:Bounds;revision:number;part:string;pointerId:number}|null>(null);
  const stage=useRef<HTMLDivElement>(null);
  const pointer=useRef<{id:string;x:number;y:number;bounds:Bounds;revision:number;part:string}|null>(null);
  const structure=useRevisionResource(artifact,'pptx-structure',async signal=>{const r=await workspaceApi.structure<Presentation>(artifact.id,signal);assertRevision(artifact,r);return r});
  const slides=structure.data?.slides??[];
  const index=Math.max(0,slides.findIndex(s=>s.id===slideId));
  const slide=slides[index];
  const size=structure.data?.slideSize;
  const renderCap=capabilities?.operations.find(op=>op.operation==='render_png');
  const workerReady=renderCap?.availability==='supported'||renderCap?.availability==='partial';
  const layered=mode!=='view';
  const scene=useRevisionResource<SlideData>(artifact,'pptx:'+String(slide?.id)+':'+layered+':'+workerReady,async signal=>{
    if(!slide||!workerReady)throw Error('スライドがありません。');
    if(!layered)return {slideId:slide.id,shapes:[],background:await workspaceApi.render(artifact,{pageIndex:index},signal),layers:[]};
    const r=await workspaceApi.range<{shapes:Shape[]}>(artifact.id,{part:slide.part},signal);assertRevision(artifact,r);
    if(r.shapes.length>60)throw Error('このスライドの編集表示は60要素まで対応しています。');
    const background=await workspaceApi.render(artifact,{pageIndex:index,variant:'background'},signal);
    const layers:SlideData['layers']=[];
    for(const shape of [...r.shapes].sort((a,b)=>a.zOrder-b.zOrder)){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      layers.push({shape,image:await workspaceApi.render(artifact,{pageIndex:index,variant:'sprite',shapeId:Number(shape.id)},signal)});
    }
    return {slideId:slide.id,shapes:r.shapes,background,layers};
  });
  const data=scene.data;
  const shape=data?.shapes.find(s=>s.id===selected);
  const structural=draft?.entries.find(e=>e.key==='pptx-structure');
  const lock=editingLocked||!!structural;
  const currentStructural=mode==='edit'&&scene.ready&&draft?.baseRevision===artifact.revision?structural:undefined;
  useEffect(()=>{fileGeneration.current++;setOperationKind('');setFileData(null);setOperationError('');return()=>{fileGeneration.current++}},[artifact.id,artifact.revision,slide?.id,mode]);
  useEffect(()=>{
    const pending=pendingNavigation.current;
    if(!pending||!structure.ready||artifact.revision===undefined||draft)return;
    if(artifact.revision!==pending.revision+1){pendingNavigation.current=null;return}
    const candidate=slides[pending.index];
    if(candidate){setSlideId(candidate.id);setSelected('')}
    pendingNavigation.current=null;
  },[artifact.revision,structure.ready,draft,slides]);
  type BasicStyle={bold?:boolean;italic?:boolean;fontSizePt?:number;fontColor?:string;fill?:string};
  type PreviewChange={shapeId:number;text?:string;boundsPt?:[number,number,number,number];style?:BasicStyle};
  type PreviewResult={signature:string;images:Map<number,Blob>;fullSlide?:Blob;status:'pending'|'ready'|'error'};
  const changes:PreviewChange[]=[];
  if(mode==='edit'&&scene.ready&&draft&&!structural&&draft.baseRevision===artifact.revision&&slide){
    for(const s of data?.shapes??[]){
      const change:PreviewChange={shapeId:Number(s.id)};
      const entries=draft.entries.filter(e=>e.operation.slidePart===slide.part&&e.operation.shapeId===change.shapeId);
      const text=entries.find(e=>e.operation.op==='pptx.set_shape_text')?.operation.text;
      const b=entries.find(e=>e.operation.op==='pptx.set_shape_bounds')?.operation.boundsPt;
      if(typeof text==='string')change.text=text;
      if(Array.isArray(b)&&b.length===4)change.boundsPt=b as [number,number,number,number];
      const style=entries.find(e=>e.operation.op==='pptx.set_shape_style')?.operation;
      if(style){const {bold,italic,fontSizePt,fontColor,fill}=style;change.style={bold:bold as boolean|undefined,italic:italic as boolean|undefined,fontSizePt:fontSizePt as number|undefined,fontColor:fontColor as string|undefined,fill:fill as string|undefined}}
      if(change.text!==undefined||change.boundsPt!==undefined||change.style!==undefined)changes.push(change);
    }
  }
  const signature=JSON.stringify([artifactVersionKey(artifact),slide?.part,changes,currentStructural?.operation]);
  const [preview,setPreview]=useState<PreviewResult|null>(null);
  const [previewRetry,setPreviewRetry]=useState(0);
  useEffect(()=>{
    if(!changes.length&&!currentStructural){setPreview(null);return;}
    const controller=new AbortController();
    const images=new Map<number,Blob>();
    setPreview({signature,images,status:'pending'});
    // Dragging and typing are immediate local operations; only settled drafts
    // invoke the heavier copy/render worker. The latest signature owns results.
    const timer=window.setTimeout(async()=>{
      try{
        if(currentStructural){
          const fullSlide=await workspaceApi.renderDraftSlide(artifact,{pageIndex:index,operation:currentStructural.operation},controller.signal);
          if(!controller.signal.aborted)setPreview({signature,images,fullSlide,status:'ready'});
          return;
        }
        for(const change of changes){
          if(controller.signal.aborted)return;
          images.set(change.shapeId,await workspaceApi.renderDraftSprite(artifact,{pageIndex:index,...change},controller.signal));
        }
        if(!controller.signal.aborted)setPreview({signature,images:new Map(images),status:'ready'});
      }catch{if(!controller.signal.aborted)setPreview({signature,images:new Map(),status:'error'})}
    },650);
    return()=>{window.clearTimeout(timer);controller.abort()};
  },[signature,previewRetry]);
  const currentPreview=preview?.signature===signature?preview:null;
  const previewReady=(changes.length>0||!!currentStructural)&&currentPreview?.status==='ready';
  const key=(id:string,kind:string)=>String(slide?.part)+':'+id+':'+kind;
  const bounds=(s:Shape):Bounds|undefined=>{const b=s.transform?.geomBoundsPt;if(!b)return;const next=draft?.entries.find(e=>e.key===key(s.id,'bounds'))?.operation.boundsPt;if(Array.isArray(next)&&next.length===4)return {x:Number(next[0]),y:Number(next[1]),width:Number(next[2]),height:Number(next[3])};return b};
  const displayBounds=(s:Shape)=>resize?.id===s.id?resize.bounds:bounds(s);
  function writeBounds(s:Shape,b:Bounds){
    if(!slide||artifact.revision===undefined||lock||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;
    const original=s.transform?.geomBoundsPt,k=key(s.id,'bounds');
    onDraft(artifact.revision,original&&Object.keys(b).every(field=>b[field as keyof Bounds]===original[field as keyof Bounds])?null:{key:k,label:s.name+' 位置・サイズ',operation:{op:'pptx.set_shape_bounds',slidePart:slide.part,shapeId:Number(s.id),boundsPt:[b.x,b.y,b.width,b.height]}},k);
  }
  function editText(v:string){
    if(!shape||!slide||artifact.revision===undefined||lock||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_text'))return;
    const k=key(shape.id,'text');onDraft(artifact.revision,v===shape.text?null:{key:k,label:shape.name+' テキスト',operation:{op:'pptx.set_shape_text',slidePart:slide.part,shapeId:Number(shape.id),text:v}},k);
  }
  const can=(op:string)=>mode==='edit'&&!lock&&scene.ready&&supportsOperation(capabilities,op);
  const styleDraft=shape?draft?.entries.find(e=>e.key===key(shape.id,'style'))?.operation:undefined;
  const styleEnabled=!!shape&&['sp','pic','cxnSp'].includes(shape.type)&&can('pptx.set_shape_style');
  function stageStyle(patch:BasicStyle){
    if(!shape||!slide||!styleEnabled||artifact.revision===undefined)return;
    const k=key(shape.id,'style');onDraft(artifact.revision,{key:k,label:shape.name+' 書式',operation:{...styleDraft,op:'pptx.set_shape_style',slidePart:slide.part,shapeId:Number(shape.id),...patch}},k);
  }
  const structureEnabled=mode==='edit'&&!editingLocked&&scene.ready&&structure.ready&&!draft&&!!slide&&!!size&&index<=500;
  const availableActions=[{id:'pptx.add_shape',label:'図形を追加'},{id:'pptx.add_image',label:'画像を追加'},{id:'pptx.add_table',label:'表を追加'},{id:'pptx.remove_shape',label:'選択要素を削除'},{id:'pptx.add_slide',label:'スライドを追加'},{id:'pptx.remove_slide',label:'スライドを削除'},{id:'pptx.reorder_slide',label:'スライド順序を変更'}].filter(a=>supportsOperation(capabilities,a.id)&&(!(a.id==='pptx.remove_shape')||!!shape)&&(!['pptx.remove_slide','pptx.reorder_slide'].includes(a.id)||slides.length>1)&&(a.id!=='pptx.add_slide'||!!structure.data?.layouts?.length));
  const addingElement=['pptx.add_shape','pptx.add_image','pptx.add_table'].includes(operationKind);
  const validBounds=newBounds.every(Number.isFinite)&&newBounds.slice(0,2).every(v=>Math.abs(v)<=14400)&&newBounds.slice(2).every(v=>v>=1&&v<=14400);
  const validOperation=!!availableActions.find(a=>a.id===operationKind)&&(!addingElement||validBounds)&&(operationKind!=='pptx.add_image'||!!fileData)&&(operationKind!=='pptx.add_slide'||!!layoutPart)&&(operationKind!=='pptx.reorder_slide'||Number.isInteger(destination)&&destination>=1&&destination<=slides.length&&destination!==index+1);
  function chooseOperation(value:string){
    fileGeneration.current++;setOperationKind(value);setOperationError('');setFileData(null);setShapeText('');setNewRows([['',''],['','']]);
    if(size)setNewBounds([Math.round(size.widthPt*.15),Math.round(size.heightPt*.15),Math.max(1,Math.round(size.widthPt*.35)),Math.max(1,Math.round(size.heightPt*.25))]);
    setLayoutPart(structure.data?.layouts?.find(l=>l.type==='blank')?.part??structure.data?.layouts?.[0]?.part??'');
    setDestination(index+1);
  }
  function stageStructure(){
    if(!structureEnabled||!validOperation||!slide||artifact.revision===undefined)return;
    let operation:EditOperation;
    switch(operationKind){
      case 'pptx.add_shape':operation={op:operationKind,slidePart:slide.part,kind:shapeKind,text:shapeText,boundsPt:newBounds};break;
      case 'pptx.add_image':operation={op:operationKind,slidePart:slide.part,imageBase64:fileData!.base64,boundsPt:newBounds};break;
      case 'pptx.add_table':operation={op:operationKind,slidePart:slide.part,rows:newRows,boundsPt:newBounds};break;
      case 'pptx.remove_shape':if(!shape||!window.confirm('選択した要素を削除しますか？'))return;operation={op:operationKind,slidePart:slide.part,shapeId:Number(shape.id)};break;
      case 'pptx.add_slide':operation={op:operationKind,index:index+1,layoutPart};break;
      case 'pptx.remove_slide':if(!window.confirm('このスライドを削除しますか？'))return;operation={op:operationKind,index};break;
      case 'pptx.reorder_slide':operation={op:operationKind,index,toIndex:destination-1};break;
      default:return;
    }
    if(['pptx.add_slide','pptx.remove_slide','pptx.reorder_slide'].includes(operation.op))pendingNavigation.current={revision:artifact.revision,index:operation.op==='pptx.add_slide'?index+1:operation.op==='pptx.remove_slide'?Math.min(index,slides.length-2):destination-1};
    onDraft(artifact.revision,{key:'pptx-structure',label:availableActions.find(a=>a.id===operationKind)!.label,operation},'pptx-structure');chooseOperation('');
  }
  const choose=(id:string)=>{setSelected(id);setDrag(null);setResize(null);resizePointer.current=null};
  const pin=()=>{if(shape&&slide&&artifact.revision!==undefined)onTarget({baseRevision:artifact.revision,label:'スライド '+(index+1)+' / '+shape.name,selector:{kind:'pptx_shape',slideId:slide.id,slidePart:slide.part,shapeId:Number(shape.id),expectedElementFingerprint:artifact.sha256},selectedContentSnapshot:shape.text,contentCoords:shape.transform?.geomBoundsPt?{...shape.transform.geomBoundsPt}:undefined})};
  const primary=<><span className="workspace-slide-counter" title="スライド番号">{index+1} / {slides.length}</span>
    {mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!shape||!scene.ready} onClick={pin}>要素を対象にする</button>}
    {mode==='edit'&&shape?.type==='sp'&&<input className="workspace-command-text" aria-label="図形テキスト" value={String(draft?.entries.find(e=>e.key===key(shape.id,'text'))?.operation.text??shape.text)} readOnly={lock||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_text')} onChange={e=>editText(e.target.value)}/>}
  </>;
  const secondary=mode==='edit'?<>
    {shape&&bounds(shape)&&['x','y','width','height'].map(field=><label key={field} className="workspace-bound">{field}<input aria-label={field} type="number" value={bounds(shape)![field as keyof Bounds]} disabled={lock||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_bounds')} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value)&&((field==='x'||field==='y')?Math.abs(value)<=14400:value>=1&&value<=14400))writeBounds(shape,{...bounds(shape)!,[field]:value})}}/></label>)}
    {styleEnabled&&<>
      {shape?.type==='sp'&&<><button type="button" className="btn btn-secondary btn-xs" onClick={()=>stageStyle({bold:true})}>太字</button><button type="button" className="btn btn-secondary btn-xs" onClick={()=>stageStyle({bold:false})}>標準</button><label className="workspace-bound">文字サイズ<input aria-label="文字サイズ" type="number" min={6} max={200} placeholder="pt" value={String(styleDraft?.fontSizePt??'')} onChange={e=>{const v=e.target.valueAsNumber;if(v>=6&&v<=200)stageStyle({fontSizePt:v})}}/></label><label>文字色<input aria-label="文字色" type="color" value={String(styleDraft?.fontColor??'#000000')} onChange={e=>stageStyle({fontColor:e.target.value})}/></label></>}
      <label>塗り<input aria-label="図形の塗り" type="color" value={String(styleDraft?.fill??'#ffffff')} onChange={e=>stageStyle({fill:e.target.value})}/></label>
    </>}
    {<select aria-label="スライド編集操作" disabled={!structureEnabled} value={operationKind} onChange={e=>chooseOperation(e.target.value)}><option value="">スライド操作…</option>{availableActions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>}
  </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={1400} closeOnButton closeOnSelect/>;
  const operationForm=mode==='edit'&&operationKind&&!structural?<div className="workspace-pptx-operation" role="group" aria-label="追加・構造変更">
    {addingElement&&<div className="workspace-toolbar">{['X','Y','幅','高さ'].map((label,i)=><label key={label} className="workspace-bound">{label}<input aria-label={'追加要素 '+label} type="number" value={Number.isFinite(newBounds[i])?newBounds[i]:''} onChange={e=>setNewBounds(v=>v.map((n,j)=>i===j?e.target.valueAsNumber:n) as [number,number,number,number])}/></label>)}</div>}
    {operationKind==='pptx.add_shape'&&<div className="workspace-toolbar"><select aria-label="追加図形" value={shapeKind} onChange={e=>setShapeKind(e.target.value as typeof shapeKind)}><option value="rectangle">四角形</option><option value="ellipse">楕円</option><option value="textbox">テキストボックス</option></select><input aria-label="追加図形テキスト" value={shapeText} maxLength={20000} onChange={e=>setShapeText(e.target.value)}/></div>}
    {operationKind==='pptx.add_image'&&<div className="workspace-toolbar"><input type="file" aria-label="スライド画像ファイル" accept="image/png,image/jpeg" onChange={e=>{const file=e.target.files?.[0];const generation=++fileGeneration.current;setFileData(null);setOperationError('');if(!file)return;if(file.size>512*1024||!['image/png','image/jpeg'].includes(file.type)){setOperationError('PNG/JPEG（512 KB以下）を選択してください。');return}const reader=new FileReader();reader.onload=()=>{if(generation===fileGeneration.current&&typeof reader.result==='string'){const base64=reader.result.split(',')[1];if(base64)setFileData({name:file.name,base64})}};reader.onerror=()=>{if(generation===fileGeneration.current)setOperationError('画像を読み込めませんでした。')};reader.readAsDataURL(file)}}/>{fileData?.name}</div>}
    {operationKind==='pptx.add_table'&&<div className="workspace-pptx-table"><table><tbody>{newRows.map((row,r)=><tr key={r}>{row.map((v,col)=><td key={col}><input aria-label={'追加表 '+(r+1)+'行 '+(col+1)+'列'} value={v} maxLength={2000} onChange={e=>setNewRows(rows=>rows.map((line,i)=>line.map((value,j)=>i===r&&j===col?e.target.value:value)))}/></td>)}</tr>)}</tbody></table><button className="btn btn-secondary btn-xs" type="button" disabled={newRows.length>=20} onClick={()=>setNewRows(rows=>[...rows,Array(rows[0].length).fill('')])}>行を追加</button><button className="btn btn-secondary btn-xs" type="button" disabled={newRows[0].length>=10} onClick={()=>setNewRows(rows=>rows.map(row=>[...row,'']))}>列を追加</button></div>}
    {operationKind==='pptx.add_slide'&&<label>レイアウト <select aria-label="スライドレイアウト" value={layoutPart} onChange={e=>setLayoutPart(e.target.value)}>{structure.data?.layouts?.map((l,i)=><option key={l.part} value={l.part}>{l.name||l.type||'レイアウト '+(i+1)}</option>)}</select></label>}
    {operationKind==='pptx.reorder_slide'&&<label>移動先 <input type="number" aria-label="移動先スライド" min={1} max={slides.length} value={destination} onChange={e=>setDestination(e.target.valueAsNumber)}/></label>}
    {operationError&&<p role="alert">{operationError}</p>}<div className="workspace-toolbar"><button type="button" className="btn btn-secondary btn-xs" disabled={!structureEnabled||!validOperation} onClick={stageStructure}>適用</button><button type="button" className="btn btn-ghost btn-xs" onClick={()=>chooseOperation('')}>取消</button></div>
  </div>:null;
  if(mode==='view'&&!workerReady)return <PdfCanvasViewer documentKey={artifact.id} url={buildArtifactContentUrl(artifact,{convertedPdf:true})}/>;
  return <div className="workspace-presentation"><nav className="workspace-slide-nav" aria-label="スライド一覧">{slides.slice(Math.max(0,index-4),index+5).map(s=><MiniSlide key={s.id} artifact={artifact} index={slides.indexOf(s)} active={s.id===slide?.id} disabled={!!structural} onClick={()=>{setSlideId(s.id);choose('')}}/>)}<button type="button" className="btn btn-secondary btn-xs" disabled={index===0||!!structural} onClick={()=>{setSlideId(slides[index-1].id);choose('')}}>前へ</button><button type="button" className="btn btn-secondary btn-xs" disabled={index+1>=slides.length||!!structural} onClick={()=>{setSlideId(slides[index+1].id);choose('')}}>次へ</button></nav>
    <UnifiedViewerZoomShell resetKey={artifact.id+':pptx'} controlsTop={<>{toolbar}{operationForm}</>} scrollClassName="workspace-pptx-scroll">
      {(structure.error||scene.error)&&<div className="error-box" role="alert">{structure.error||scene.error}<button type="button" onClick={()=>{structure.retry();scene.retry()}}>再試行</button></div>}
      {scene.loading&&data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
      {!data||!size?.widthPt||!size.heightPt?<div className="workspace-loading">{scene.error||structure.error?'スライドを表示できません。':'読み込み中…'}</div>:<div className="workspace-slide" ref={stage} style={{aspectRatio:size.widthPt+'/'+size.heightPt,'--slide-ratio':size.widthPt/size.heightPt} as React.CSSProperties} data-slide-canvas="true" data-preview-ready={previewReady?'true':'false'}>
        {currentStructural&&previewReady&&currentPreview?.fullSlide?<Layer blob={currentPreview.fullSlide} alt="変更後のスライド"/>:<>
        <Layer blob={data.background} alt="スライド背景"/>
        {data.layers.map(({shape:s,image})=>{
          const exact=previewReady?currentPreview?.images.get(Number(s.id)):undefined;
          const b=displayBounds(s),orig=exact?bounds(s):s.transform?.geomBoundsPt;
          const dx=(b&&orig?b.x-orig.x:0)+(drag?.id===s.id?drag.dx:0),dy=(b&&orig?b.y-orig.y:0)+(drag?.id===s.id?drag.dy:0);
          // One full-slide transparent sprite per element. Scale around the original
          // geometry origin, then translate; never retain a second original layer.
          const sx=orig&&b&&orig.width>0?b.width/orig.width:1,sy=orig&&b&&orig.height>0?b.height/orig.height:1;
          return <Layer key={s.id} blob={exact??image} style={{transformOrigin:orig?(orig.x/size.widthPt*100+'% '+orig.y/size.heightPt*100+'%'):undefined,
            transform:'translate('+dx/size.widthPt*100+'%,'+dy/size.heightPt*100+'%) scale('+sx+','+sy+')'}}/>})}
        {!currentStructural&&data.shapes.map(s=>{const b=displayBounds(s);if(!b||b.width<=0||b.height<=0)return null;const active=selected===s.id||target?.selector.shapeId===Number(s.id);return <button key={s.id} type="button" aria-label={s.name||'図形 '+s.id} className={'workspace-shape-hit '+(active?'selected':'')} style={{left:(b.x+(drag?.id===s.id?drag.dx:0))/size.widthPt*100+'%',top:(b.y+(drag?.id===s.id?drag.dy:0))/size.heightPt*100+'%',width:b.width/size.widthPt*100+'%',height:b.height/size.heightPt*100+'%'}} onClick={()=>choose(s.id)}
          onPointerDown={e=>{choose(s.id);if(mode!=='edit'||lock||!scene.ready||!slide||artifact.revision===undefined||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;pointer.current={id:s.id,x:e.clientX,y:e.clientY,bounds:b,revision:artifact.revision,part:slide.part};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();if(p?.id===s.id&&rect?.width&&rect.height)setDrag({id:s.id,dx:(e.clientX-p.x)/rect.width*size.widthPt,dy:(e.clientY-p.y)/rect.height*size.heightPt})}}
          onPointerCancel={()=>{pointer.current=null;setDrag(null)}}
          onPointerUp={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();pointer.current=null;setDrag(null);if(p?.id===s.id&&p.revision===artifact.revision&&p.part===slide?.part&&rect?.width&&rect.height){const dx=(e.clientX-p.x)/rect.width*size.widthPt,dy=(e.clientY-p.y)/rect.height*size.heightPt;if(Math.abs(dx)+Math.abs(dy)>0.5)writeBounds(s,{...p.bounds,x:p.bounds.x+dx,y:p.bounds.y+dy})}}}/>}
        )}
        {!currentStructural&&mode==='edit'&&shape&&displayBounds(shape)&&!shape.transform?.rotationDegrees&&can('pptx.set_shape_bounds')&&<button type="button" className="workspace-shape-hit workspace-resize-handle" aria-label="選択要素をリサイズ" style={{left:(displayBounds(shape)!.x+displayBounds(shape)!.width)/size.widthPt*100+'%',top:(displayBounds(shape)!.y+displayBounds(shape)!.height)/size.heightPt*100+'%'}}
          onPointerDown={e=>{if(!slide||artifact.revision===undefined)return;e.stopPropagation();const b=bounds(shape)!;resizePointer.current={id:shape.id,x:e.clientX,y:e.clientY,bounds:b,revision:artifact.revision,part:slide.part,pointerId:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const p=resizePointer.current,rect=stage.current?.getBoundingClientRect();if(p?.id===shape.id&&p.pointerId===e.pointerId&&rect?.width&&rect.height)setResize({id:p.id,bounds:{...p.bounds,width:Math.min(14400,Math.max(1,p.bounds.width+(e.clientX-p.x)/rect.width*size.widthPt)),height:Math.min(14400,Math.max(1,p.bounds.height+(e.clientY-p.y)/rect.height*size.heightPt))}})}}
          onPointerUp={e=>{const p=resizePointer.current,rect=stage.current?.getBoundingClientRect();resizePointer.current=null;setResize(null);if(p?.id===shape.id&&p.revision===artifact.revision&&p.part===slide?.part&&p.pointerId===e.pointerId&&rect?.width&&rect.height){writeBounds(shape,{...p.bounds,width:Math.min(14400,Math.max(1,p.bounds.width+(e.clientX-p.x)/rect.width*size.widthPt)),height:Math.min(14400,Math.max(1,p.bounds.height+(e.clientY-p.y)/rect.height*size.heightPt))})}}}
          onPointerCancel={()=>{resizePointer.current=null;setResize(null)}} onLostPointerCapture={()=>{resizePointer.current=null;setResize(null)}}
          onKeyDown={e=>{const b=bounds(shape);if(!b)return;const step=e.shiftKey?10:1;const delta:Record<string,[number,number]>={ArrowRight:[step,0],ArrowLeft:[-step,0],ArrowDown:[0,step],ArrowUp:[0,-step]};if(delta[e.key]){e.preventDefault();writeBounds(shape,{...b,width:Math.min(14400,Math.max(1,b.width+delta[e.key][0])),height:Math.min(14400,Math.max(1,b.height+delta[e.key][1]))})}}}/>} 
        </>}
      </div>}
      {currentStructural&&<div className="workspace-toolbar" role="status">{currentStructural.label}（保存前プレビュー）<button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>{pendingNavigation.current=null;if(artifact.revision!==undefined)onDraft(artifact.revision,null,'pptx-structure')}}>取消</button></div>}
      {(changes.length>0||!!currentStructural)&&!previewReady&&<p className="muted-xs workspace-draft-preview-status">{currentPreview?.status==='error'?<>変更後の描画に失敗しました。<button type="button" className="btn btn-secondary btn-xs" onClick={()=>setPreviewRetry(v=>v+1)}>再試行</button></>:'変更後の描画を更新中…'}</p>}
    </UnifiedViewerZoomShell></div>
}
