import React,{useEffect,useRef,useState} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { workspaceApi,supportsOperation,MAX_WORKSPACE_IMAGE_BYTES,type EditOperation, type WorkspaceTableCellEdit } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { PdfCanvasViewer } from '../../shared-ui/document/PdfCanvasCore';
import {
  ElementTargetControl,
  PinModeToolbar,
  PreviewUnavailableFallback,
  SpatialPinOverlay,
  TargetInspectionErrorBanner,
  WholeTargetControl,
  useRegisteredPinModes,
  type NormalizedArea,
} from '../../shared-ui/pin';
import { artifactVersionKey, buildArtifactContentUrl } from '../../../utils/viewerCache';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import { preparePptxOperations,projectSlides,type ProjectedSlide } from '../pptxDraft';
import type { DraftEntry, WorkspaceModuleProps } from '../types';
type Slide={id:string;part:string};
type TargetSlide={slideId:string;slideHash:string;shapes:{id:string;name:string;text:string;groupPath:string[];fingerprint:string}[]};
type Bounds={x:number;y:number;width:number;height:number};
type ShapeTransform={geomBoundsPt?:Bounds;rotationDegrees?:number;flipH?:boolean;flipV?:boolean;chOff?:[number,number];chExt?:[number,number]};
function shapeMatrix(bounds:Bounds,transform?:ShapeTransform){
  return new DOMMatrix().translate(bounds.x+bounds.width/2,bounds.y+bounds.height/2)
    .rotate(transform?.rotationDegrees??0)
    .scale(transform?.flipH?-1:1,transform?.flipV?-1:1)
    .translate(-bounds.width/2,-bounds.height/2);
}
function shapeTransformStyle(transform?:ShapeTransform):React.CSSProperties{
  if(!transform)return {};
  const {rotationDegrees=0,flipH,flipV}=transform;
  return {transform:`rotate(${rotationDegrees}deg) scale(${flipH?-1:1},${flipV?-1:1})`,transformOrigin:'center'};
}
type BasicGeometry={kind:'rect'|'ellipse';fill:string;stroke:string;strokeWidthPt:number};
type Sprite={image:Blob;ink?:Bounds};
type Shape={children?:Shape[];addition?:DraftEntry;tableRows?:{text:string;editable:boolean}[][];id:string;name:string;type:string;text:string;zOrder:number;basicGeometry?:BasicGeometry|null;transform?:ShapeTransform};
function groupShapeHits(root:Shape,parent=new DOMMatrix()):Array<{shape:Shape;points:DOMPoint[]}>{
  const bounds=root.transform?.geomBoundsPt;
  if(!bounds||bounds.width<=0||bounds.height<=0)return [];
  const matrix=parent.multiply(shapeMatrix(bounds,root.transform));
  const points=[[0,0],[bounds.width,0],[bounds.width,bounds.height],[0,bounds.height]]
    .map(([x,y])=>matrix.transformPoint(new DOMPoint(x,y)));
  const offset=root.transform?.chOff,extent=root.transform?.chExt;
  const children=offset&&extent&&extent[0]>0&&extent[1]>0
    ? [...root.children??[]].sort((a,b)=>a.zOrder-b.zOrder).flatMap(child=>
        groupShapeHits(child,matrix.scale(bounds.width/extent[0],bounds.height/extent[1]).translate(-offset[0],-offset[1])))
    : [];
  return [{shape:root,points},...children];
}
type Presentation={slides:Slide[];layouts?:{part:string;name:string;type:string}[];slideSize:{widthPt:number;heightPt:number}};
type SlideData={slideId:string;shapes:Shape[];background:Blob;layers:{shape:Shape;sprite?:Sprite}[]};
/** Read crop coordinates from the native worker's PNG tEXt chunk. */
async function readSprite(image:Blob):Promise<Sprite>{
  const bytes=await image.arrayBuffer(),view=new DataView(bytes),decoder=new TextDecoder();
  for(let pos=8;pos+12<=view.byteLength;){
    const length=view.getUint32(pos);
    if(length>view.byteLength-pos-12)break;
    const type=decoder.decode(new Uint8Array(bytes,pos+4,4));
    if(type==='tEXt'&&length<4096){
      const data=decoder.decode(new Uint8Array(bytes,pos+8,length));
      if(data.startsWith('inkBoundsPt\0')){
        const ink=JSON.parse(data.slice(12)) as Bounds;
        if([ink.x,ink.y,ink.width,ink.height].every(Number.isFinite)&&ink.x>=0&&ink.y>=0&&ink.width>=0&&ink.height>=0)return {image,ink};
        throw Error('描画境界が無効です。');
      }
    }
    pos+=length+12;
  }
  // Older render fixtures return a full-slide PNG; retain the full-slide path.
  return {image};
}
const BasicLayer=React.memo(function BasicLayer({shapeId,zOrder,geometry,bounds,slideWidth,slideHeight,dx,dy,transform}:{shapeId:string;zOrder:number;geometry:BasicGeometry;bounds:Bounds;slideWidth:number;slideHeight:number;dx:number;dy:number;transform?:ShapeTransform}){
  const {width,height}=bounds;
  if(width<=0||height<=0)return null;
  const paint={fill:geometry.fill,stroke:geometry.stroke,strokeWidth:geometry.strokeWidthPt};
  return <svg aria-hidden="true" data-basic-geometry={geometry.kind} data-shape-id={shapeId} data-z-order={zOrder} data-layer-kind="basic" viewBox={'0 0 '+width+' '+height} preserveAspectRatio="none" style={{position:'absolute',pointerEvents:'none',overflow:'visible',left:(bounds.x+dx)/slideWidth*100+'%',top:(bounds.y+dy)/slideHeight*100+'%',width:width/slideWidth*100+'%',height:height/slideHeight*100+'%',...shapeTransformStyle(transform)}}>
    {geometry.kind==='rect'?<rect x={0} y={0} width={width} height={height} {...paint}/>:<ellipse cx={width/2} cy={height/2} rx={width/2} ry={height/2} {...paint}/>}
  </svg>;
});
function useImage(blob:Blob|undefined){
  const [image,setImage]=useState<{blob:Blob;url:string}|null>(null);
  useEffect(()=>{if(!blob){setImage(null);return}const u=URL.createObjectURL(blob);setImage({blob,url:u});return()=>URL.revokeObjectURL(u)},[blob]);
  return image?.blob===blob?image?.url??'':'';
}
function Layer({blob,style,alt='',shapeId,zOrder,layerKind}:{blob:Blob;style?:React.CSSProperties;alt?:string;shapeId?:string;zOrder?:number;layerKind?:string}){
  const url=useImage(blob);return url?<img className="workspace-slide-layer" draggable={false} src={url} style={style} alt={alt} data-shape-id={shapeId} data-z-order={zOrder} data-layer-kind={layerKind}/>:null;
}
function MiniSlide({artifact,index,baseIndex,active,onClick,style}:{artifact:WorkspaceModuleProps['artifact'];index:number;baseIndex?:number;active:boolean;onClick:()=>void;style?:React.CSSProperties}){
  const r=useRevisionResource<Blob|null>(artifact,'thumb:'+baseIndex,async signal=>{
    return baseIndex===undefined?null:workspaceApi.render(artifact,{pageIndex:baseIndex},signal);
  });
  const url=useImage(r.ready?r.data??undefined:undefined);
  return <button type="button" className={'workspace-slide-nav-item '+(active?'active':'')} style={style} data-slide-index={index} aria-label={'スライド '+(index+1)} aria-pressed={active} onClick={onClick}>{url?<img src={url} alt=""/>:<span>{index+1}</span>}<small>{index+1}</small></button>;
}
function SlideThumbnailRail({artifact,slides,activeSlideId,activeIndex,onSelect}:{artifact:WorkspaceModuleProps['artifact'];slides:ProjectedSlide[];activeSlideId?:string;activeIndex:number;onSelect:(slideId:string)=>void}){
  const listRef=useRef<HTMLDivElement>(null);
  const [compact,setCompact]=useState(()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'?window.matchMedia('(max-width: 600px)').matches:false);
  useEffect(()=>{
    if(typeof window==='undefined'||typeof window.matchMedia!=='function')return;
    const mq=window.matchMedia('(max-width: 600px)');
    const update=()=>setCompact(mq.matches);
    update();
    mq.addEventListener?.('change',update);
    return()=>mq.removeEventListener?.('change',update);
  },[]);
  const virtualizer=useVirtualizer({
    count:slides.length,
    getScrollElement:()=>listRef.current,
    horizontal:compact,
    estimateSize:()=>compact?82:84,
    overscan:4,
    initialRect:compact?{width:360,height:54}:{width:116,height:560},
  });
  useEffect(()=>{
    if(activeIndex>=0&&activeIndex<slides.length){
      virtualizer.scrollToIndex(activeIndex,{align:'auto'});
    }
  },[activeIndex,slides.length,compact,virtualizer]);
  const items=virtualizer.getVirtualItems();
  const totalSize=virtualizer.getTotalSize();
  return <div ref={listRef} className="workspace-slide-nav-list" data-virtualized="true" data-total-slides={slides.length}>
    <div className="workspace-slide-nav-track" style={compact?{width:totalSize+'px',height:'100%',position:'relative'}:{height:totalSize+'px',width:'100%',position:'relative'}}>
      {items.map(vItem=>{
        const s=slides[vItem.index];
        if(!s)return null;
        return <MiniSlide
          key={s.id}
          artifact={artifact}
          index={vItem.index}
          active={s.id===activeSlideId}
          baseIndex={s.baseIndex}
          onClick={()=>onSelect(s.id)}
          style={compact
            ?{position:'absolute',top:0,left:0,width:'76px',height:'100%',transform:`translateX(${vItem.start}px)`}
            :{position:'absolute',top:0,left:0,width:'100%',height:'78px',transform:`translateY(${vItem.start}px)`}}
        />;
      })}
    </div>
  </div>;
}
export function PptxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,beginTargetSelection,target,jumpTarget}:WorkspaceModuleProps){
  const [slideId,setSlideId]=useState('');
  const [selected,setSelected]=useState('');
  const [baseShape,setBaseShape]=useState('');
  const [canvasText,setCanvasText]=useState(false);
  const sequence=useRef(0);
  const [operationKind,setOperationKind]=useState('');
  const [shapeText,setShapeText]=useState('');
  const [shapeKind,setShapeKind]=useState<'rectangle'|'ellipse'|'textbox'>('rectangle');
  const [newBounds,setNewBounds]=useState<[number,number,number,number]>([10,10,120,60]);
  const [newRows,setNewRows]=useState([['',''],['','']]);
  const [layoutPart,setLayoutPart]=useState('');
  const [destination,setDestination]=useState(1);
  const [fileData,setFileData]=useState<{name:string;base64:string}|null>(null);
  const [operationError,setOperationError]=useState('');
  const [jumpInput,setJumpInput]=useState('');
  const fileGeneration=useRef(0);
  const pendingNavigation=useRef<{revision:number;index:number}|null>(null);
  const [drag,setDrag]=useState<{id:string;dx:number;dy:number}|null>(null);
  const [resize,setResize]=useState<{id:string;bounds:Bounds}|null>(null);
  const resizePointer=useRef<{id:string;x:number;y:number;bounds:Bounds;revision:number;part:string;pointerId:number}|null>(null);
  const stage=useRef<HTMLDivElement>(null);
  const pointer=useRef<{id:string;x:number;y:number;bounds:Bounds;revision:number;part:string}|null>(null);
  const structure=useRevisionResource(artifact,'pptx-structure',async signal=>{const r=await workspaceApi.structure<Presentation>(artifact.id,signal);assertRevision(artifact,r);return r});
  const savedSlides=structure.data?.slides??[];
  const liveDraft=mode==='edit'&&draft?.baseRevision===artifact.revision?draft:null;
  const structural=(liveDraft?.entries??[]).filter(e=>e.key.startsWith('pptx-structure:'));
  const operations=preparePptxOperations(liveDraft?.entries.map(e=>e.operation)??[]);
  const slides=projectSlides(savedSlides,operations);
  const index=Math.max(0,slides.findIndex(s=>s.id===slideId));
  const slide=slides[index];
  const baseIndex=slide?.baseIndex;
  const size=structure.data?.slideSize;
  const renderCap=capabilities?.operations.find(op=>op.operation==='render_png');
  const workerReady=renderCap?.availability==='supported'||renderCap?.availability==='partial';
  const pinState=useRegisteredPinModes({
    format:'pptx',
    filename:artifact.filename,
    previewKind:artifact.previewKind,
    view:workerReady?'full':'base',
    capabilities,
    beginWorkspaceSelection:beginTargetSelection,
    scope:JSON.stringify([slideId,selected,baseShape]),
  });
  const activePrimitive=pinState.activeMode?.primitive;
  const layered=mode!=='view';
  const targetStructure=useRevisionResource<TargetSlide|null>(artifact,'pptx-target:'+String(slide?.part)+':'+mode+':'+workerReady,async signal=>{
    if(mode!=='pin'||!slide)return null;
    const result=await workspaceApi.range<TargetSlide>(artifact.id,{part:slide.part,targetMetadata:true},signal);
    assertRevision(artifact,result);return result;
  });
  const scene=useRevisionResource<SlideData|null>(artifact,JSON.stringify(['pptx',slide?.id,slide?.part,baseIndex,layered,workerReady]),async signal=>{
    if(!slide||!workerReady||baseIndex===undefined)return null;
    if(!layered)return {slideId:slide.id,shapes:[],background:await workspaceApi.render(artifact,{pageIndex:baseIndex},signal),layers:[]};
    const r=await workspaceApi.range<{shapes:Shape[]}>(artifact.id,{part:slide.part},signal);assertRevision(artifact,r);
    const background=await workspaceApi.render(artifact,{pageIndex:baseIndex,variant:'background'},signal);
    const layers:SlideData['layers']=[];
    for(const shape of [...r.shapes].sort((a,b)=>a.zOrder-b.zOrder)){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      layers.push(shape.basicGeometry?{shape}:{shape,sprite:await readSprite(await workspaceApi.render(artifact,{pageIndex:baseIndex,variant:'sprite',shapeId:Number(shape.id),cropSprite:'true'},signal))});
    }
    return {slideId:slide.id,shapes:r.shapes,background,layers};
  });
  const data=scene.data;
  const sceneReady=structure.ready&&(slide?.draftSlideKey?workerReady:scene.ready);
  const lock=editingLocked;
  const removedShapeIds=new Set(operations.filter(op=>op.op==='pptx.remove_shape'&&op.slidePart===slide?.part).map(op=>Number(op.shapeId)));
  const pendingShapes:Shape[]=mode==='edit'?structural.flatMap(entry=>{
    const op=entry.operation;
    if((op.draftSlideKey??op.slidePart)!==slide?.part||!Array.isArray(op.boundsPt))return [];
    const type=op.op==='pptx.add_shape'?'sp':op.op==='pptx.add_image'?'pic':op.op==='pptx.add_table'?'graphicFrame':null;
    if(!type)return [];
    const [x,y,width,height]=op.boundsPt as number[];
    const rows=op.rows as string[][]|undefined;
    return [{id:entry.key,name:entry.label,type,text:String(op.text??''),zOrder:(data?.shapes.length??0)+structural.indexOf(entry),
      addition:entry,transform:{geomBoundsPt:{x,y,width,height}},
      tableRows:rows?.map(row=>row.map(text=>({text,editable:true})))}];
  }):[];
  const selectableShapes=[...(data?.shapes??[]).filter(s=>!removedShapeIds.has(Number(s.id))),...pendingShapes].sort((a,b)=>a.zOrder-b.zOrder);
  const shape=selectableShapes.find(s=>s.id===selected);
  useEffect(()=>{
    if(slideId&&slide&&slideId!==slide.id&&structure.ready&&!pendingNavigation.current){
      setSlideId(slide.id);
      setSelected('');
      setCanvasText(false);
    }
  },[slideId,slide?.id,structure.ready]);
  useEffect(()=>{fileGeneration.current++;setOperationKind('');setFileData(null);setOperationError('');return()=>{fileGeneration.current++}},[artifact.id,artifact.revision,slide?.id,mode]);
  useEffect(()=>{
    if(slide?.draftSlideKey&&artifact.revision!==undefined&&liveDraft){
      pendingNavigation.current={revision:artifact.revision,index};
      return;
    }
    if(liveDraft){pendingNavigation.current=null;return}
    const pending=pendingNavigation.current;
    if(!pending||!structure.ready||artifact.revision===undefined||draft)return;
    if(artifact.revision===pending.revision+1){
      const candidate=savedSlides[pending.index];
      if(candidate){setSlideId(candidate.id);setSelected('')}
    }
    pendingNavigation.current=null;
  },[artifact.revision,structure.ready,draft,liveDraft,savedSlides,slide?.id,index]);
  type BasicStyle={bold?:boolean;italic?:boolean;fontSizePt?:number;fontColor?:string;fill?:string};
  type PreviewChange={shapeId:number;text?:string;boundsPt?:[number,number,number,number];style?:BasicStyle;cells?:WorkspaceTableCellEdit[]};
  type PreviewResult={signature:string;images:Map<string,Sprite>;status:'pending'|'ready'|'error'};
  const changes:PreviewChange[]=[];
  if(sceneReady&&liveDraft&&slide){
    for(const s of selectableShapes.filter(shape=>!shape.addition)){
      const change:PreviewChange={shapeId:Number(s.id)};
      const entries=liveDraft.entries.filter(e=>e.operation.slidePart===slide.part&&e.operation.shapeId===change.shapeId);
      const text=entries.find(e=>e.operation.op==='pptx.set_shape_text')?.operation.text;
      const b=entries.find(e=>e.operation.op==='pptx.set_shape_bounds')?.operation.boundsPt;
      if(typeof text==='string')change.text=text;
      if(Array.isArray(b)&&b.length===4)change.boundsPt=b as [number,number,number,number];
      const style=entries.find(e=>e.operation.op==='pptx.set_shape_style')?.operation;
      if(style){const {bold,italic,fontSizePt,fontColor,fill}=style;change.style={bold:bold as boolean|undefined,italic:italic as boolean|undefined,fontSizePt:fontSizePt as number|undefined,fontColor:fontColor as string|undefined,fill:fill as string|undefined}}
      const cells=entries.filter(e=>e.operation.op==='pptx.set_table_cell').map(({operation})=>({
        row:Number(operation.row),column:Number(operation.column),text:String(operation.text),
      }));
      if(cells.length)change.cells=cells;
      if(change.text!==undefined||change.boundsPt!==undefined||change.style!==undefined||change.cells!==undefined)changes.push(change);
    }
  }
  const draftSlideAddition=operations.find(op=>op.op==='pptx.add_slide'&&op.draftSlideKey===slide?.draftSlideKey);
  const draftBackground=useRevisionResource<Blob|null>(artifact,'pptx-background:'+String(draftSlideAddition?.draftSlideKey),async signal=>{
    if(!draftSlideAddition||!sceneReady)return null;
    return workspaceApi.renderDraftSlide(artifact,{
      pageIndex:0,operations:[{...draftSlideAddition,index:0}],variant:'background',
    },signal);
  });
  const needsSprites=sceneReady&&(changes.length>0||pendingShapes.length>0);
  const needsPreview=needsSprites||!!draftSlideAddition;
  const signature=JSON.stringify([artifactVersionKey(artifact),slide?.id,changes,
    pendingShapes.length?[index,operations]:null]);
  const [preview,setPreview]=useState<PreviewResult|null>(null);
  const [previewRetry,setPreviewRetry]=useState(0);
  useEffect(()=>{
    if(!needsSprites){setPreview(null);return;}
    const controller=new AbortController();
    const images=new Map<string,Sprite>();
    setPreview({signature,images:new Map(),status:'pending'});
    const timer=window.setTimeout(async()=>{
      const publish=(status:PreviewResult['status'])=>{
        if(!controller.signal.aborted)setPreview({signature,images:new Map(images),status});
      };
      try{
        for(const change of changes){
          if(controller.signal.aborted||baseIndex===undefined)return;
          images.set(String(change.shapeId),await readSprite(await workspaceApi.renderDraftSprite(artifact,{pageIndex:baseIndex,...change,cropSprite:true},controller.signal)));
          publish('pending');
        }
        for(const shape of pendingShapes){
          if(controller.signal.aborted)return;
          images.set(shape.id,await readSprite(await workspaceApi.renderDraftSlide(artifact,{
            pageIndex:index,operations,variant:'sprite',draftShapeKey:shape.id,
          },controller.signal)));
          publish('pending');
        }
        publish('ready');
      }catch{publish('error')}
    },650);
    return()=>{window.clearTimeout(timer);controller.abort()};
  },[signature,previewRetry,needsSprites]);
  const currentPreview=preview?.signature===signature?preview:null;
  const previewReady=sceneReady&&(!needsSprites||currentPreview?.status==='ready')&&
    (!draftSlideAddition||draftBackground.ready)&&(needsPreview||structural.length>0);
  const background=data?.background??draftBackground.data;
  const key=(id:string,kind:string)=>String(slide?.part)+':'+id+':'+kind;
  const bounds=(s:Shape):Bounds|undefined=>{const b=s.transform?.geomBoundsPt;if(!b)return;const next=draft?.entries.find(e=>e.key===key(s.id,'bounds'))?.operation.boundsPt;if(Array.isArray(next)&&next.length===4)return {x:Number(next[0]),y:Number(next[1]),width:Number(next[2]),height:Number(next[3])};return b};
  const displayBounds=(s:Shape)=>resize?.id===s.id?resize.bounds:bounds(s);
  function updateAddition(entry:DraftEntry,patch:Partial<EditOperation>){
    if(lock||!sceneReady||artifact.revision===undefined)return;
    onDraft(artifact.revision,{...entry,operation:{...entry.operation,...patch}},entry.key);
  }
  function writeBounds(s:Shape,b:Bounds){
    if(!slide||artifact.revision===undefined||lock||!sceneReady||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;
    if(s.addition){updateAddition(s.addition,{boundsPt:[b.x,b.y,b.width,b.height]});return}
    const original=s.transform?.geomBoundsPt,k=key(s.id,'bounds');
    onDraft(artifact.revision,original&&Object.keys(b).every(field=>b[field as keyof Bounds]===original[field as keyof Bounds])?null:{key:k,label:s.name+' 位置・サイズ',operation:{op:'pptx.set_shape_bounds',slidePart:slide.part,shapeId:Number(s.id),boundsPt:[b.x,b.y,b.width,b.height]}},k);
  }
  function editText(v:string){
    if(!shape||!slide||artifact.revision===undefined||lock||!sceneReady||!supportsOperation(capabilities,'pptx.set_shape_text'))return;
    if(shape.addition){updateAddition(shape.addition,{text:v});return}
    const k=key(shape.id,'text');onDraft(artifact.revision,v===shape.text?null:{key:k,label:shape.name+' テキスト',operation:{op:'pptx.set_shape_text',slidePart:slide.part,shapeId:Number(shape.id),text:v}},k);
  }
  const can=(op:string)=>mode==='edit'&&!lock&&sceneReady&&supportsOperation(capabilities,op);
  const styleDraft=shape?.addition
    ? shape.addition.operation.style as BasicStyle|undefined
    : shape?draft?.entries.find(e=>e.key===key(shape.id,'style'))?.operation:undefined;
  const styleEnabled=!!shape&&['sp','pic','cxnSp'].includes(shape.type)&&can('pptx.set_shape_style');
  function stageStyle(patch:BasicStyle){
    if(!shape||!slide||!styleEnabled||artifact.revision===undefined)return;
    if(shape.addition){updateAddition(shape.addition,{style:{...styleDraft,...patch}});return}
    const k=key(shape.id,'style');onDraft(artifact.revision,{key:k,label:shape.name+' 書式',operation:{...styleDraft,op:'pptx.set_shape_style',slidePart:slide.part,shapeId:Number(shape.id),...patch}},k);
  }
  const structureEnabled=mode==='edit'&&!editingLocked&&sceneReady&&structure.ready&&!!slide&&!!size&&index>=0;
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
    const draftKey='pptx-structure:'+(++sequence.current);
    const location=slide.draftSlideKey?{draftSlideKey:slide.draftSlideKey}:{slidePart:slide.part};
    let operation:EditOperation;
    switch(operationKind){
      case 'pptx.add_shape':operation={op:operationKind,...location,draftShapeKey:draftKey,kind:shapeKind,text:shapeText,boundsPt:newBounds};break;
      case 'pptx.add_image':operation={op:operationKind,...location,draftShapeKey:draftKey,imageBase64:fileData!.base64,boundsPt:newBounds};break;
      case 'pptx.add_table':operation={op:operationKind,...location,draftShapeKey:draftKey,rows:newRows,boundsPt:newBounds};break;
      case 'pptx.remove_shape':if(!shape||!window.confirm('選択した要素を削除しますか？'))return;
        if(shape.addition){onDraft(artifact.revision,null,shape.addition.key);choose('');chooseOperation('');return}
        operation={op:operationKind,slidePart:slide.part,shapeId:Number(shape.id)};choose('');break;
      case 'pptx.add_slide':
        operation={op:operationKind,index:index+1,layoutPart,draftSlideKey:draftKey};setSlideId(draftKey);choose('');break;
      case 'pptx.remove_slide':
        if(!window.confirm('このスライドを削除しますか？'))return;
        operation={op:operationKind,index};setSlideId((slides[index+1]??slides[index-1]).id);choose('');break;
      case 'pptx.reorder_slide':operation={op:operationKind,index,toIndex:destination-1};break;
      default:return;
    }
    onDraft(artifact.revision,{key:draftKey,label:availableActions.find(a=>a.id===operationKind)!.label,operation},draftKey);
    if(addingElement)choose(draftKey);
    chooseOperation('');
  }
  const choose=(id:string)=>{setSelected(id);setCanvasText(false);setDrag(null);setResize(null);resizePointer.current=null};
  React.useLayoutEffect(()=>{
    if(!jumpTarget)return;
    const selectedSlide=savedSlides.find(item=>item.id===String(jumpTarget.selector.slideId));
    if(!selectedSlide)return;
    if(jumpTarget.selector.kind==='pptx_element'&&typeof jumpTarget.coords?.shapeId!=='number')return;
    const selectedShape=typeof jumpTarget.coords?.shapeId==='number'?String(jumpTarget.coords.shapeId):'';
    setSlideId(selectedSlide.id);setBaseShape(selectedShape);choose(selectedShape);
  },[jumpTarget,structure.ready]);
  async function pin(
    targetSlide: Slide,
    shapeId?: string,
    contentCoords?: Record<string, unknown>,
    rectPt?: [number, number, number, number],
  ) {
    if (artifact.revision === undefined) return;
    const isCurrent = pinState.selection.begin();
    pinState.clearPinError();
    try {
      const metadata = await pinState.inspectTarget<TargetSlide & { revision?: number; sha256?: string }>(artifact, { part: targetSlide.part });
      if (!isCurrent()) return;
      const element = shapeId ? metadata.shapes.find((item) => item.id === shapeId) : undefined;
      if (shapeId && !element) throw Error('選択した要素を識別できません。');
      const pageIndex = savedSlides.findIndex((item) => item.id === targetSlide.id);
      const label = 'スライド ' + (pageIndex + 1);
      if (!isCurrent()) return;
      if (rectPt) {
        onTarget({
          baseRevision: artifact.revision,
          label: label + ' / 矩形領域',
          selector: {
            kind: 'pptx_region',
            slideId: targetSlide.id,
            rectPt,
            expectedSlideHash: metadata.slideHash,
          },
          selectedContentSnapshot: metadata.shapes.map((item) => item.text).filter(Boolean).join('\n').slice(0, 50_000),
          contentCoords: {
            pageIndex,
            unit: 'pt',
            rectPt,
            ...(size ? { widthPt: size.widthPt, heightPt: size.heightPt } : {}),
          },
        });
        return;
      }
      const isPoint = Boolean(!element && contentCoords && typeof contentCoords.xPt === 'number' && typeof contentCoords.yPt === 'number' && size);
      onTarget({
        baseRevision: artifact.revision,
        label: element ? label + ' / ' + element.name : isPoint ? label + ' / ピン' : label,
        selector: element
          ? {
              kind: 'pptx_element',
              slideId: targetSlide.id,
              shapeId: Number(element.id),
              groupPath: element.groupPath,
              expectedElementFingerprint: element.fingerprint,
            }
          : {
              kind: 'pptx_slide',
              slideId: targetSlide.id,
              expectedSlideHash: metadata.slideHash,
              ...(isPoint && size
                ? {
                    pointPt: {
                      xPt: contentCoords!.xPt,
                      yPt: contentCoords!.yPt,
                      widthPt: size.widthPt,
                      heightPt: size.heightPt,
                    },
                  }
                : {}),
            },
        selectedContentSnapshot: (element ? element.text : metadata.shapes.map((item) => item.text).filter(Boolean).join('\n')).slice(0, 50_000),
        contentCoords,
      });
    } catch (e) {
      if (isCurrent()) pinState.setPinError(e instanceof Error ? e.message : '対象を識別できません。');
    }
  }
  const shapeOptions = (targetStructure.data?.shapes ?? []).map((item) => ({ id: item.id, label: item.name }));
  const primary = (
    <>
      <span className="workspace-slide-counter" title="スライド番号">{index + 1} / {slides.length}</span>
      {mode === 'pin' && pinState.modes.length > 0 && (
        <PinModeToolbar
          ariaLabel="PPTX の対象指定"
          selectLabel="PPTX の選択方法"
          options={pinState.modes}
          value={pinState.activeModeId}
          onChange={pinState.setModeId}
        >
          {activePrimitive === 'whole' && (
            <WholeTargetControl
              label={pinState.activeMode?.actionLabel ?? 'スライド全体を対象にする'}
              disabled={!slide || !targetStructure.ready}
              onSelect={() => { if (slide) void pin(slide); }}
            />
          )}
          {activePrimitive === 'element' && (
            <ElementTargetControl
              ariaLabel="対象要素"
              elements={shapeOptions}
              selectedId={selected}
              onSelectId={choose}
              actionLabel={pinState.activeMode?.actionLabel}
              actionDisabled={!slide || !selected || (!shape && !targetStructure.ready)}
              onConfirm={() => {
                if (!slide || !selected) return;
                void pin(
                  slide,
                  selected,
                  shape?.transform?.geomBoundsPt ? { ...shape.transform.geomBoundsPt, pageIndex: index, unit: 'pt' } : undefined,
                );
              }}
            />
          )}
        </PinModeToolbar>
      )}
      {mode === 'edit' && shape?.type === 'sp' && (
        <input
          className="workspace-command-text"
          aria-label="図形テキスト"
          value={String(draft?.entries.find((e) => e.key === key(shape.id, 'text'))?.operation.text ?? shape.text)}
          readOnly={lock || !sceneReady || !supportsOperation(capabilities, 'pptx.set_shape_text')}
          onChange={(e) => editText(e.target.value)}
        />
      )}
    </>
  );
  const secondary=mode==='edit'?<>
    {shape&&bounds(shape)&&['x','y','width','height'].map(field=><label key={field} className="workspace-bound">{field}<input aria-label={field} type="number" value={bounds(shape)![field as keyof Bounds]} disabled={lock||!sceneReady||!supportsOperation(capabilities,'pptx.set_shape_bounds')} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value)&&((field==='x'||field==='y')?Math.abs(value)<=14400:value>=1&&value<=14400))writeBounds(shape,{...bounds(shape)!,[field]:value})}}/></label>)}
    {styleEnabled&&<>
      {shape?.type==='sp'&&<><button type="button" className="btn btn-secondary btn-xs" onClick={()=>stageStyle({bold:true})}>太字</button><button type="button" className="btn btn-secondary btn-xs" onClick={()=>stageStyle({bold:false})}>標準</button><label className="workspace-bound">文字サイズ<input aria-label="文字サイズ" type="number" min={6} max={200} placeholder="pt" value={String(styleDraft?.fontSizePt??'')} onChange={e=>{const v=e.target.valueAsNumber;if(v>=6&&v<=200)stageStyle({fontSizePt:v})}}/></label><label>文字色<input aria-label="文字色" type="color" value={String(styleDraft?.fontColor??'#000000')} onChange={e=>stageStyle({fontColor:e.target.value})}/></label></>}
      <label>塗り<input aria-label="図形の塗り" type="color" value={String(styleDraft?.fill??'#ffffff')} onChange={e=>stageStyle({fill:e.target.value})}/></label>
    </>}
    {<select aria-label="スライド編集操作" disabled={!structureEnabled} value={operationKind} onChange={e=>chooseOperation(e.target.value)}><option value="">スライド操作…</option>{availableActions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>}
  </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={1400} closeOnButton closeOnSelect/>;
  const tableEditor=mode==='edit'&&shape?.tableRows&&(shape.addition||supportsOperation(capabilities,'pptx.set_table_cell'))&&
    <div className="workspace-pptx-table" role="group" aria-label={shape.name+' のセル'}>
      <table><tbody>{shape.tableRows.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,column)=>{
        const cellKey=key(shape.id,'cell:'+rowIndex+':'+column);
        const text=String(draft?.entries.find(entry=>entry.key===cellKey)?.operation.text??cell.text);
        return <td key={column}>{cell.editable?<textarea rows={Math.min(4,text.split('\n').length)}
          aria-label={(rowIndex+1)+'行 '+(column+1)+'列'} value={text} maxLength={20000}
          readOnly={lock||!sceneReady} onChange={event=>{
            if(!slide||artifact.revision===undefined||(!shape.addition&&!can('pptx.set_table_cell')))return;
            const value=event.target.value;
            if(shape.addition){
              const rows=(shape.addition.operation.rows as string[][]).map((line,r)=>
                r===rowIndex?line.map((text,c)=>c===column?value:text):line,
              );
              updateAddition(shape.addition,{rows});return;
            }
            onDraft(artifact.revision,value===cell.text?null:{
              key:cellKey,label:shape.name+' '+(rowIndex+1)+'行 '+(column+1)+'列',
              operation:{op:'pptx.set_table_cell',slidePart:slide.part,shapeId:Number(shape.id),row:rowIndex,column,text:value},
            },cellKey);
          }}/>:cell.text}</td>;
      })}</tr>)}</tbody></table>
    </div>;
  const operationForm=mode==='edit'&&operationKind?<div className="workspace-pptx-operation" role="group" aria-label="追加・構造変更">
    {addingElement&&<div className="workspace-toolbar workspace-toolbar-fields">{['X','Y','幅','高さ'].map((label,i)=><label key={label} className="workspace-bound">{label}<input aria-label={'追加要素 '+label} type="number" value={Number.isFinite(newBounds[i])?newBounds[i]:''} onChange={e=>setNewBounds(v=>v.map((n,j)=>i===j?e.target.valueAsNumber:n) as [number,number,number,number])}/></label>)}</div>}
    {operationKind==='pptx.add_shape'&&<div className="workspace-toolbar workspace-toolbar-fields"><select aria-label="追加図形" value={shapeKind} onChange={e=>setShapeKind(e.target.value as typeof shapeKind)}><option value="rectangle">四角形</option><option value="ellipse">楕円</option><option value="textbox">テキストボックス</option></select><input aria-label="追加図形テキスト" value={shapeText} maxLength={20000} onChange={e=>setShapeText(e.target.value)}/></div>}
    {operationKind==='pptx.add_image'&&<div className="workspace-toolbar workspace-toolbar-fields"><input type="file" aria-label="スライド画像ファイル" accept="image/png,image/jpeg" onChange={e=>{const file=e.target.files?.[0];const generation=++fileGeneration.current;setFileData(null);setOperationError('');if(!file)return;if(file.size>MAX_WORKSPACE_IMAGE_BYTES||!['image/png','image/jpeg'].includes(file.type)){setOperationError('PNG/JPEG（6 MB以下）を選択してください。');return}const reader=new FileReader();reader.onload=()=>{if(generation===fileGeneration.current&&typeof reader.result==='string'){const base64=reader.result.split(',')[1];if(base64)setFileData({name:file.name,base64})}};reader.onerror=()=>{if(generation===fileGeneration.current)setOperationError('画像を読み込めませんでした。')};reader.readAsDataURL(file)}}/>{fileData?.name}</div>}
    {operationKind==='pptx.add_table'&&<div className="workspace-pptx-table"><table><tbody>{newRows.map((row,r)=><tr key={r}>{row.map((v,col)=><td key={col}><input aria-label={'追加表 '+(r+1)+'行 '+(col+1)+'列'} value={v} maxLength={20000} onChange={e=>setNewRows(rows=>rows.map((line,i)=>line.map((value,j)=>i===r&&j===col?e.target.value:value)))}/></td>)}</tr>)}</tbody></table><button className="btn btn-secondary btn-xs" type="button" disabled={newRows.length>=100} onClick={()=>setNewRows(rows=>[...rows,Array(rows[0].length).fill('')])}>行を追加</button><button className="btn btn-secondary btn-xs" type="button" disabled={newRows[0].length>=30} onClick={()=>setNewRows(rows=>rows.map(row=>[...row,'']))}>列を追加</button></div>}
    {operationKind==='pptx.add_slide'&&<label>レイアウト <select aria-label="スライドレイアウト" value={layoutPart} onChange={e=>setLayoutPart(e.target.value)}>{structure.data?.layouts?.map((l,i)=><option key={l.part} value={l.part}>{l.name||l.type||'レイアウト '+(i+1)}</option>)}</select></label>}
    {operationKind==='pptx.reorder_slide'&&<label>移動先 <input type="number" aria-label="移動先スライド" min={1} max={slides.length} value={destination} onChange={e=>setDestination(e.target.valueAsNumber)}/></label>}
    {operationError&&<p role="alert">{operationError}</p>}<div className="workspace-toolbar workspace-toolbar-fields"><button type="button" className="btn btn-secondary btn-xs" disabled={!structureEnabled||!validOperation} onClick={stageStructure}>適用</button><button type="button" className="btn btn-ghost btn-xs" onClick={()=>chooseOperation('')}>取消</button></div>
  </div>:null;
  const downloadUrl = buildArtifactContentUrl(artifact);
  if (!workerReady && (mode === 'view' || mode === 'pin')) {
    return (
      <div className="workspace-page-view">
        {mode === 'pin' && pinState.modes.length > 0 && (
          <PinModeToolbar
            ariaLabel="スライドの対象指定"
            selectLabel="PPTX の選択方法"
            options={pinState.modes}
            value={pinState.activeModeId}
            onChange={pinState.setModeId}
            className="workspace-pptx-target-bar"
          >
            <label>
              スライド{' '}
              <select aria-label="対象スライド" value={slide?.id ?? ''} onChange={(event) => { setSlideId(event.target.value); setBaseShape(''); }}>
                {slides.map((item, i) => <option key={item.id} value={item.id}>{i + 1}</option>)}
              </select>
            </label>
            {activePrimitive === 'whole' && (
              <WholeTargetControl
                label={pinState.activeMode?.actionLabel ?? 'スライド全体を対象にする'}
                disabled={!slide || !targetStructure.ready}
                onSelect={() => { if (slide) void pin(slide); }}
              />
            )}
            {activePrimitive === 'element' && (
              <ElementTargetControl
                ariaLabel="対象要素"
                elements={targetStructure.ready ? shapeOptions : []}
                selectedId={baseShape}
                onSelectId={setBaseShape}
                actionLabel={pinState.activeMode?.actionLabel}
                actionDisabled={!slide || !targetStructure.ready || !baseShape}
                onConfirm={() => { if (slide && baseShape) void pin(slide, baseShape); }}
              />
            )}
          </PinModeToolbar>
        )}
        {mode === 'pin' && (pinState.pinError || structure.error || targetStructure.error) && (
          <TargetInspectionErrorBanner
            message={pinState.pinError || structure.error || targetStructure.error || ''}
            onRetry={() => { pinState.clearPinError(); structure.retry(); targetStructure.retry(); }}
            onDismiss={pinState.pinError ? pinState.clearPinError : undefined}
          />
        )}
        <PdfCanvasViewer
          jumpLocation={jumpTarget?.coords}
          documentKey={artifact.id}
          filename={artifact.filename}
          url={buildArtifactContentUrl(artifact, { convertedPdf: true })}
          selectionMode={mode === 'pin' && (activePrimitive === 'point' || activePrimitive === 'rect') ? (activePrimitive === 'rect' ? 'region' : 'pin') : undefined}
          onSelectLocation={mode === 'pin' ? (location) => {
            const clicked = slides[location.pageIndex];
            if (!clicked) return;
            const widthPt = size?.widthPt ?? location.pageWidth;
            const heightPt = size?.heightPt ?? location.pageHeight;
            if (activePrimitive === 'rect' && location.width > 0 && location.height > 0) {
              void pin(clicked, undefined, undefined, [
                location.x * widthPt,
                location.y * heightPt,
                location.width * widthPt,
                location.height * heightPt,
              ]);
            } else {
              void pin(clicked, undefined, {
                pageIndex: location.pageIndex,
                unit: 'pt',
                xPt: location.x * widthPt,
                yPt: location.y * heightPt,
              });
            }
          } : undefined}
        />
      </div>
    );
  }
  const jumpToSlide=(raw:string)=>{
    const num=Number(raw);
    if(!Number.isInteger(num)||num<1||num>slides.length)return;
    const targetSlide=slides[num-1];
    if(targetSlide){setSlideId(targetSlide.id);choose('');setJumpInput('')}
  };
  return <div className="workspace-presentation"><nav className="workspace-slide-nav" aria-label="スライド一覧" data-total-slides={slides.length}>
      <div className="workspace-slide-nav-controls">
        <button type="button" className="btn btn-secondary btn-xs" disabled={index===0} onClick={()=>{setSlideId(slides[index-1].id);choose('')}}>前へ</button>
        <button type="button" className="btn btn-secondary btn-xs" disabled={index+1>=slides.length} onClick={()=>{setSlideId(slides[index+1].id);choose('')}}>次へ</button>
      </div>
      {slides.length>5&&<form className="workspace-slide-jump" onSubmit={e=>{e.preventDefault();jumpToSlide(jumpInput)}}>
        <input type="number" min={1} max={slides.length} aria-label="スライド番号へ移動" placeholder={`1–${slides.length}`} value={jumpInput} onChange={e=>setJumpInput(e.target.value)}/>
        <button type="submit" className="btn btn-secondary btn-xs">移動</button>
      </form>}
      <SlideThumbnailRail
        artifact={artifact}
        slides={slides}
        activeSlideId={slide?.id}
        activeIndex={index}
        onSelect={id=>{setSlideId(id);choose('')}}
      />
    </nav>
    <UnifiedViewerZoomShell resetKey={artifact.id+':pptx'} controlsTop={<>{toolbar}{operationForm}{tableEditor}</>} scrollClassName="workspace-pptx-scroll">
      {(data||draftSlideAddition)&&(structure.error||scene.error)&&(
        <TargetInspectionErrorBanner
          message={structure.error||scene.error||''}
          onRetry={()=>{structure.retry();scene.retry()}}
        />
      )}
      {scene.loading&&data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
      {(!data&&!draftSlideAddition)||!size?.widthPt||!size.heightPt?(
        scene.error||structure.error?(
          <PreviewUnavailableFallback
            reason={scene.error||structure.error}
            downloadUrl={downloadUrl}
            filename={artifact.filename}
            onRetry={()=>{structure.retry();scene.retry()}}
          />
        ):<div className="workspace-loading">読み込み中…</div>
      ):(() => {
        const spatialPinActive = mode === 'pin' && (activePrimitive === 'point' || activePrimitive === 'rect');
        const activeSpatialSource = jumpTarget?.selector.slideId === slide?.id
          ? jumpTarget.coords
          : target?.selector.slideId === slide?.id
            ? target.contentCoords
            : undefined;
        let slideHighlightArea: NormalizedArea | null = null;
        if (activeSpatialSource && size.widthPt > 0 && size.heightPt > 0) {
          if (Array.isArray(activeSpatialSource.rectPt) && activeSpatialSource.rectPt.length === 4) {
            const [rx, ry, rw, rh] = activeSpatialSource.rectPt.map(Number);
            if ([rx, ry, rw, rh].every(Number.isFinite)) {
              slideHighlightArea = { x: rx / size.widthPt, y: ry / size.heightPt, width: rw / size.widthPt, height: rh / size.heightPt };
            }
          } else if (typeof activeSpatialSource.xPt === 'number' && typeof activeSpatialSource.yPt === 'number') {
            slideHighlightArea = { x: activeSpatialSource.xPt / size.widthPt, y: activeSpatialSource.yPt / size.heightPt, width: 0, height: 0 };
          }
        }
        return <div className="workspace-slide" ref={stage} style={{aspectRatio:size.widthPt+'/'+size.heightPt,'--slide-ratio':size.widthPt/size.heightPt} as React.CSSProperties} data-slide-canvas="true" data-slide-id={slide?.id} data-scene-ready={sceneReady} data-preview-ready={previewReady?'true':'false'}>
        {background&&<Layer blob={background} alt="スライド背景" layerKind="background"/>}
        {[...(data?.layers??[]).filter(({shape:s})=>!removedShapeIds.has(Number(s.id))),...pendingShapes.map(shape=>({shape,sprite:undefined}))].map(({shape:s,sprite})=>{
          const exact=currentPreview?.images.get(s.id);
          const b=displayBounds(s),orig=exact?bounds(s):s.transform?.geomBoundsPt;
          const dx=(b&&orig?b.x-orig.x:0)+(drag?.id===s.id?drag.dx:0),dy=(b&&orig?b.y-orig.y:0)+(drag?.id===s.id?drag.dy:0);
          if(!exact&&s.basicGeometry&&b)return <BasicLayer key={s.id} shapeId={s.id} zOrder={s.zOrder} geometry={s.basicGeometry} bounds={b} slideWidth={size.widthPt} slideHeight={size.heightPt} dx={drag?.id===s.id?drag.dx:0} dy={drag?.id===s.id?drag.dy:0} transform={s.transform}/>;
          const rendered=exact??sprite;
          if(!rendered){
            if(!s.addition||!b)return null;
            return <div key={s.id} className="workspace-draft-shape" aria-hidden="true" data-shape-id={s.id} data-z-order={s.zOrder} data-layer-kind="draft-shape"
              style={{left:(b.x+(drag?.id===s.id?drag.dx:0))/size.widthPt*100+'%',top:(b.y+(drag?.id===s.id?drag.dy:0))/size.heightPt*100+'%',width:b.width/size.widthPt*100+'%',height:b.height/size.heightPt*100+'%'}}>{s.text}</div>;
          }
          const sx=orig&&b&&orig.width>0?b.width/orig.width:1,sy=orig&&b&&orig.height>0?b.height/orig.height:1;
          if(rendered.ink){
            const ink=rendered.ink;
            if(!ink.width||!ink.height)return null;
            const x=orig?orig.x+(ink.x-orig.x)*sx+dx:ink.x+dx,y=orig?orig.y+(ink.y-orig.y)*sy+dy:ink.y+dy;
            return <Layer key={s.id} blob={rendered.image} shapeId={s.id} zOrder={s.zOrder} layerKind="sprite-ink" style={{left:x/size.widthPt*100+'%',top:y/size.heightPt*100+'%',width:ink.width*sx/size.widthPt*100+'%',height:ink.height*sy/size.heightPt*100+'%'}}/>;
          }
          return <Layer key={s.id} blob={rendered.image} shapeId={s.id} zOrder={s.zOrder} layerKind="sprite-full" style={{transformOrigin:orig?(orig.x/size.widthPt*100+'% '+orig.y/size.heightPt*100+'%'):undefined,
            transform:'translate('+dx/size.widthPt*100+'%,'+dy/size.heightPt*100+'%) scale('+sx+','+sy+')'}}/>})}
        {selectableShapes.map(s=>{
          const b=displayBounds(s);
          if(!b||b.width<=0||b.height<=0)return null;
          const active=selected===s.id||(target?.selector.slideId===slide?.id&&target?.selector.shapeId===Number(s.id));
          const rendered=currentPreview?.images.get(s.id)??data?.layers.find(layer=>layer.shape.id===s.id)?.sprite;
          const origin=s.transform?.geomBoundsPt;
          const ink=rendered?.ink;
          const offsetX=drag?.id===s.id?drag.dx:0,offsetY=drag?.id===s.id?drag.dy:0;
          const hit=ink&&origin&&origin.width>0&&origin.height>0&&ink.width>0&&ink.height>0?{
            x:b.x+(ink.x-origin.x)*b.width/origin.width,y:b.y+(ink.y-origin.y)*b.height/origin.height,
            width:ink.width*b.width/origin.width,height:ink.height*b.height/origin.height,
          }:b;
          const hitTransform=hit===b?shapeTransformStyle(s.transform):{};
          return <React.Fragment key={s.id}><button type="button" aria-label={s.name||'図形 '+s.id} data-shape-id={s.id} data-z-order={s.zOrder} className={'workspace-shape-hit '+(active?'selected':'')} style={{
            left:(hit.x+offsetX)/size.widthPt*100+'%',top:(hit.y+offsetY)/size.heightPt*100+'%',
            width:hit.width/size.widthPt*100+'%',height:hit.height/size.heightPt*100+'%',
            ...hitTransform,...(s.basicGeometry?.kind==='ellipse'?{borderRadius:'50%'}:{}),
            ...(spatialPinActive?{pointerEvents:'none'}:{}),
          }} onClick={()=>choose(s.id)}
          onDoubleClick={()=>{if(s.type==='sp'&&can('pptx.set_shape_text')){setSelected(s.id);setCanvasText(true)}}}
          onKeyDown={event=>{
            if(event.key==='F2'&&s.type==='sp'&&can('pptx.set_shape_text')){event.preventDefault();setSelected(s.id);setCanvasText(true);return;}
            const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
            const offset=delta[event.key];
            if(offset&&can('pptx.set_shape_bounds')){event.preventDefault();writeBounds(s,{...b,x:b.x+offset[0]*(event.shiftKey?10:1),y:b.y+offset[1]*(event.shiftKey?10:1)})}
          }}
          onPointerDown={e=>{choose(s.id);if(mode!=='edit'||lock||!sceneReady||!slide||artifact.revision===undefined||!supportsOperation(capabilities,'pptx.set_shape_bounds'))return;pointer.current={id:s.id,x:e.clientX,y:e.clientY,bounds:b,revision:artifact.revision,part:slide.part};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();if(p?.id===s.id&&rect?.width&&rect.height)setDrag({id:s.id,dx:(e.clientX-p.x)/rect.width*size.widthPt,dy:(e.clientY-p.y)/rect.height*size.heightPt})}}
          onPointerCancel={()=>{pointer.current=null;setDrag(null)}}
          onPointerUp={e=>{const p=pointer.current,rect=stage.current?.getBoundingClientRect();pointer.current=null;setDrag(null);if(p?.id===s.id&&p.revision===artifact.revision&&p.part===slide?.part&&rect?.width&&rect.height){const dx=(e.clientX-p.x)/rect.width*size.widthPt,dy=(e.clientY-p.y)/rect.height*size.heightPt;if(Math.abs(dx)+Math.abs(dy)>0.5)writeBounds(s,{...p.bounds,x:p.bounds.x+dx,y:p.bounds.y+dy})}}}/>
          {mode==='pin'&&!spatialPinActive&&s.children?.length?groupShapeHits(s).slice(1).map(({shape:child,points})=>{
            const left=Math.min(...points.map(point=>point.x)),top=Math.min(...points.map(point=>point.y));
            const width=Math.max(...points.map(point=>point.x))-left,height=Math.max(...points.map(point=>point.y))-top;
            if(width<=0||height<=0)return null;
            const polygon=points.map(point=>`${(point.x-left)/width*100}% ${(point.y-top)/height*100}%`).join(',');
            return <button key={child.id} type="button" aria-label={child.name||'図形 '+child.id} data-shape-id={child.id}
              className={'workspace-shape-hit '+(selected===child.id?'selected':'')} style={{
                left:left/size.widthPt*100+'%',top:top/size.heightPt*100+'%',
                width:width/size.widthPt*100+'%',height:height/size.heightPt*100+'%',clipPath:`polygon(${polygon})`,
              }} onClick={()=>choose(child.id)}/>;
          }):null}
          </React.Fragment>}
        )}
        {spatialPinActive && slide && sceneReady && (
          <SpatialPinOverlay
            mode={activePrimitive === 'rect' ? 'region' : 'pin'}
            ariaLabel={`スライド ${index + 1}${activePrimitive === 'point' ? 'のピン位置' : 'の矩形領域'}`}
            highlightedArea={slideHighlightArea}
            resetKey={`${artifact.id}:${artifact.revision}:${slide.id}`}
            onCommit={(area) => {
              if (activePrimitive === 'rect' && area.width > 0 && area.height > 0) {
                void pin(slide, undefined, undefined, [
                  area.x * size.widthPt,
                  area.y * size.heightPt,
                  area.width * size.widthPt,
                  area.height * size.heightPt,
                ]);
              } else {
                void pin(slide, undefined, {
                  pageIndex: index,
                  unit: 'pt',
                  xPt: area.x * size.widthPt,
                  yPt: area.y * size.heightPt,
                });
              }
            }}
          />
        )}
        {!spatialPinActive && slideHighlightArea && (
          <span
            aria-hidden="true"
            className={`shared-pin-mark ${slideHighlightArea.width === 0 && slideHighlightArea.height === 0 ? 'is-point' : 'is-rect'}`}
            style={{
              left: `${slideHighlightArea.x * 100}%`,
              top: `${slideHighlightArea.y * 100}%`,
              width: `${slideHighlightArea.width * 100}%`,
              height: `${slideHighlightArea.height * 100}%`,
            }}
          />
        )}
        {mode==='edit'&&canvasText&&shape&&displayBounds(shape)&&<textarea autoFocus className="workspace-slide-text"
          aria-label="キャンバス内の図形テキスト" style={{left:displayBounds(shape)!.x/size.widthPt*100+'%',top:displayBounds(shape)!.y/size.heightPt*100+'%',
          width:displayBounds(shape)!.width/size.widthPt*100+'%',minHeight:displayBounds(shape)!.height/size.heightPt*100+'%'}}
          value={String(draft?.entries.find(e=>e.key===key(shape.id,'text'))?.operation.text??shape.text)}
          onChange={event=>editText(event.target.value)} onBlur={()=>setCanvasText(false)}
          onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setCanvasText(false)}}}/>}
        {mode==='edit'&&!canvasText&&shape&&displayBounds(shape)&&!shape.transform?.rotationDegrees&&can('pptx.set_shape_bounds')&&<button type="button" className="workspace-shape-hit workspace-resize-handle" aria-label="選択要素をリサイズ" style={{left:(displayBounds(shape)!.x+displayBounds(shape)!.width)/size.widthPt*100+'%',top:(displayBounds(shape)!.y+displayBounds(shape)!.height)/size.heightPt*100+'%'}}
          onPointerDown={e=>{if(!slide||artifact.revision===undefined)return;e.stopPropagation();const b=bounds(shape)!;resizePointer.current={id:shape.id,x:e.clientX,y:e.clientY,bounds:b,revision:artifact.revision,part:slide.part,pointerId:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const p=resizePointer.current,rect=stage.current?.getBoundingClientRect();if(p?.id===shape.id&&p.pointerId===e.pointerId&&rect?.width&&rect.height)setResize({id:p.id,bounds:{...p.bounds,width:Math.min(14400,Math.max(1,p.bounds.width+(e.clientX-p.x)/rect.width*size.widthPt)),height:Math.min(14400,Math.max(1,p.bounds.height+(e.clientY-p.y)/rect.height*size.heightPt))}})}}
          onPointerUp={e=>{const p=resizePointer.current,rect=stage.current?.getBoundingClientRect();resizePointer.current=null;setResize(null);if(p?.id===shape.id&&p.revision===artifact.revision&&p.part===slide?.part&&p.pointerId===e.pointerId&&rect?.width&&rect.height){writeBounds(shape,{...p.bounds,width:Math.min(14400,Math.max(1,p.bounds.width+(e.clientX-p.x)/rect.width*size.widthPt)),height:Math.min(14400,Math.max(1,p.bounds.height+(e.clientY-p.y)/rect.height*size.heightPt))})}}}
          onPointerCancel={()=>{resizePointer.current=null;setResize(null)}} onLostPointerCapture={()=>{resizePointer.current=null;setResize(null)}}
          onKeyDown={e=>{const b=bounds(shape);if(!b)return;const step=e.shiftKey?10:1;const delta:Record<string,[number,number]>={ArrowRight:[step,0],ArrowLeft:[-step,0],ArrowDown:[0,step],ArrowUp:[0,-step]};if(delta[e.key]){e.preventDefault();writeBounds(shape,{...b,width:Math.min(14400,Math.max(1,b.width+delta[e.key][0])),height:Math.min(14400,Math.max(1,b.height+delta[e.key][1]))})}}}/>} 
      </div>; })()}
      {structural.length>0&&<div className="workspace-toolbar workspace-toolbar-fields" role="status">
        {structural.map(entry=><span key={entry.key}>{entry.label}</span>)}
        <button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>{
          pendingNavigation.current=null;
          const entry=structural.at(-1);if(entry&&artifact.revision!==undefined)onDraft(artifact.revision,null,entry.key)
        }}>最後の構造変更を取消</button>
      </div>}
      {mode==='pin'&&pinState.pinError&&<TargetInspectionErrorBanner message={pinState.pinError} onDismiss={pinState.clearPinError}/>}
      {needsPreview&&!previewReady&&<p className="muted-xs workspace-draft-preview-status">{currentPreview?.status==='error'||draftBackground.error?<>変更後の描画に失敗しました。<button type="button" className="btn btn-secondary btn-xs" onClick={()=>{draftBackground.retry();setPreviewRetry(v=>v+1)}}>再試行</button></>:'変更後の描画を更新中…'}</p>}
    </UnifiedViewerZoomShell></div>
}
