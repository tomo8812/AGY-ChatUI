import React,{useEffect,useRef,useState} from 'react';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
type Slide={id:string;part:string};
type Bounds={x:number;y:number;width:number;height:number};
type Shape={id:string;name:string;type:string;text:string;zOrder:number;transform?:{geomBoundsPt?:Bounds;rotationDegrees?:number}};
type Presentation={slides:Slide[];slideSize:{widthPt:number;heightPt:number}};
type SlideData={slideId:string;shapes:Shape[];background:Blob;layers:{shape:Shape;image:Blob}[]};
function useImage(blob:Blob|undefined){
  const [url,setUrl]=useState('');
  useEffect(()=>{if(!blob){setUrl('');return}const u=URL.createObjectURL(blob);setUrl(u);return()=>URL.revokeObjectURL(u)},[blob]);
  return url;
}
function Layer({blob,style,alt=''}:{blob:Blob;style?:React.CSSProperties;alt?:string}){
  const url=useImage(blob);return url?<img className="workspace-slide-layer" draggable={false} src={url} style={style} alt={alt}/>:null;
}
function MiniSlide({artifact,index,active,onClick}:{artifact:WorkspaceModuleProps['artifact'];index:number;active:boolean;onClick:()=>void}){
  const r=useRevisionResource(artifact,'thumb:'+index,signal=>workspaceApi.render(artifact,{pageIndex:index},signal));
  const url=useImage(r.ready?r.data??undefined:undefined);
  return <button type="button" className={'workspace-slide-nav-item '+(active?'active':'')} aria-label={'スライド '+(index+1)} aria-pressed={active} onClick={onClick}>{url?<img src={url} alt=""/>:<span> {index+1} </span>}<small>{index+1}</small></button>;
}
export function PptxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,target}:WorkspaceModuleProps){
  const [slideId,setSlideId]=useState('');
  const [selected,setSelected]=useState('');
  const [drag,setDrag]=useState<{id:string;dx:number;dy:number}|null>(null);
  const stage=useRef<HTMLDivElement>(null);
  const pointer=useRef<{id:string;x:number;y:number;bounds:Bounds;revision:number;part:string}|null>(null);
  const structure=useRevisionResource(artifact,'pptx-structure',async signal=>{const r=await workspaceApi.structure<Presentation>(artifact.id,signal);assertRevision(artifact,r);return r});
  const slides=structure.ready?structure.data?.slides??[]:[];
  const index=Math.max(0,slides.findIndex(s=>s.id===slideId));
  const slide=slides[index];
  const size=structure.data?.slideSize;
  const layered=mode!=='view';
  const scene=useRevisionResource<SlideData>(artifact,'pptx:'+String(slide?.id)+':'+layered,async signal=>{
    if(!slide)throw Error('スライドがありません。');
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
  const data=scene.ready?scene.data:null;
  const shape=data?.shapes.find(s=>s.id===selected);
  const key=(id:string,kind:string)=>String(slide?.part)+':'+id+':'+kind;
  const bounds=(s:Shape):Bounds|undefined=>{const b=s.transform?.geomBoundsPt;if(!b)return;const next=draft?.entries.find(e=>e.key===key(s.id,'bounds'))?.operation.boundsPt;if(Array.isArray(next)&&next.length===4)return {x:Number(next[0]),y:Number(next[1]),width:Number(next[2]),height:Number(next[3])};return b};
  function writeBounds(s:Shape,b:Bounds){
    if(!slide||artifact.revision===undefined||editingLocked||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;
    const original=s.transform?.geomBoundsPt,k=key(s.id,'bounds');
    onDraft(artifact.revision,original&&Object.keys(b).every(field=>b[field as keyof Bounds]===original[field as keyof Bounds])?null:{key:k,label:s.name+' 位置・サイズ',operation:{op:'pptx.set_shape_bounds',slidePart:slide.part,shapeId:Number(s.id),boundsPt:[b.x,b.y,b.width,b.height]}},k);
  }
  function editText(v:string){
    if(!shape||!slide||artifact.revision===undefined||editingLocked||!scene.ready||!supportsOperation(capabilities,'pptx.set_shape_text'))return;
    const k=key(shape.id,'text');onDraft(artifact.revision,v===shape.text?null:{key:k,label:shape.name+' テキスト',operation:{op:'pptx.set_shape_text',slidePart:slide.part,shapeId:Number(shape.id),text:v}},k);
  }
  const choose=(id:string)=>{setSelected(id);setDrag(null)};
  const pin=()=>{if(shape&&slide&&artifact.revision!==undefined)onTarget({baseRevision:artifact.revision,label:'スライド '+(index+1)+' / '+shape.name,selector:{kind:'pptx_shape',slideId:slide.id,slidePart:slide.part,shapeId:Number(shape.id),expectedElementFingerprint:artifact.sha256},selectedContentSnapshot:shape.text,contentCoords:shape.transform?.geomBoundsPt?{...shape.transform.geomBoundsPt}:undefined})};
  const toolbar=<div className="workspace-toolbar"><span>スライド {index+1} / {slides.length}</span>
    {mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!shape||!scene.ready} onClick={pin}>要素を対象にする</button>}
    {mode==='edit'&&shape?.type==='sp'&&<input aria-label="図形テキスト" value={String(draft?.entries.find(e=>e.key===key(shape.id,'text'))?.operation.text??shape.text)} readOnly={editingLocked||!supportsOperation(capabilities,'pptx.set_shape_text')} onChange={e=>editText(e.target.value)}/>}
    {mode==='edit'&&shape&&bounds(shape)&&['x','y','width','height'].map(field=><label key={field} className="workspace-bound">{field}<input aria-label={field} type="number" value={bounds(shape)![field as keyof Bounds]} disabled={editingLocked||!supportsOperation(capabilities,'pptx.set_shape_bounds')} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value)&&((field==='x'||field==='y')?Math.abs(value)<=14400:value>=1&&value<=14400))writeBounds(shape,{...bounds(shape)!,[field]:value})}}/></label>)}
  </div>;
  return <div className="workspace-presentation"><nav className="workspace-slide-nav" aria-label="スライド一覧">{slides.slice(Math.max(0,index-4),index+5).map(s=><MiniSlide key={s.id} artifact={artifact} index={slides.indexOf(s)} active={s.id===slide?.id} onClick={()=>{setSlideId(s.id);choose('')}}/>)}<button type="button" className="btn btn-secondary btn-xs" disabled={index===0} onClick={()=>{setSlideId(slides[index-1].id);choose('')}}>前へ</button><button type="button" className="btn btn-secondary btn-xs" disabled={index+1>=slides.length} onClick={()=>{setSlideId(slides[index+1].id);choose('')}}>次へ</button></nav>
    <UnifiedViewerZoomShell resetKey={artifact.id+':pptx'} controlsTop={toolbar}>
      {(structure.error||scene.error)&&<div className="error-box" role="alert">{structure.error||scene.error}<button type="button" onClick={()=>{structure.retry();scene.retry()}}>再試行</button></div>}
      {!data||!size?.widthPt||!size.heightPt?<div className="workspace-loading">読み込み中…</div>:<div className="workspace-slide" ref={stage} style={{aspectRatio:size.widthPt+'/'+size.heightPt}} data-slide-canvas="true">
        <Layer blob={data.background} alt="スライド背景"/>
        {data.layers.map(({shape:s,image})=>{const orig=s.transform?.geomBoundsPt,b=bounds(s);const dx=(b&&orig?b.x-orig.x:0)+(drag?.id===s.id?drag.dx:0),dy=(b&&orig?b.y-orig.y:0)+(drag?.id===s.id?drag.dy:0);
          // Server sprites use full-slide coordinates. Translation does not duplicate the original shape.
          return <Layer key={s.id} blob={image} style={{transform:'translate('+dx/size.widthPt*100+'%,'+dy/size.heightPt*100+'%)'}}/>})}
        {data.shapes.map(s=>{const b=bounds(s);if(!b||b.width<=0||b.height<=0)return null;const active=selected===s.id||target?.selector.shapeId===Number(s.id);return <button key={s.id} type="button" aria-label={s.name||'図形 '+s.id} className={'workspace-shape-hit '+(active?'selected':'')} style={{left:(b.x+(drag?.id===s.id?drag.dx:0))/size.widthPt*100+'%',top:(b.y+(drag?.id===s.id?drag.dy:0))/size.heightPt*100+'%',width:b.width/size.widthPt*100+'%',height:b.height/size.heightPt*100+'%'}} onClick={()=>choose(s.id)}
          onPointerDown={e=>{choose(s.id);if(mode!=='edit'||editingLocked||!slide||artifact.revision===undefined||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;pointer.current={id:s.id,x:e.clientX,y:e.clientY,bounds:b,revision:artifact.revision,part:slide.part};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();if(p?.id===s.id&&rect?.width&&rect.height)setDrag({id:s.id,dx:(e.clientX-p.x)/rect.width*size.widthPt,dy:(e.clientY-p.y)/rect.height*size.heightPt})}}
          onPointerCancel={()=>{pointer.current=null;setDrag(null)}}
          onPointerUp={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();pointer.current=null;setDrag(null);if(p?.id===s.id&&p.revision===artifact.revision&&p.part===slide?.part&&rect?.width&&rect.height){const dx=(e.clientX-p.x)/rect.width*size.widthPt,dy=(e.clientY-p.y)/rect.height*size.heightPt;if(Math.abs(dx)+Math.abs(dy)>0.5)writeBounds(s,{...p.bounds,x:p.bounds.x+dx,y:p.bounds.y+dy})}}}/>}
        )}
      </div>}
      {mode==='edit'&&draft?.entries.some(e=>e.operation.op==='pptx.set_shape_text'||e.operation.op==='pptx.set_shape_bounds')&&<p className="muted-xs">テキストとサイズ変更の正式な描画は保存後に更新されます。</p>}
    </UnifiedViewerZoomShell></div>
}
