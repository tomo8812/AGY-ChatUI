import React,{useRef,useState} from 'react';
import { PdfCanvasViewer,type PdfLocation } from '../../shared-ui/document/PdfCanvasCore';
import type { PdfTextSelection } from '../../shared-ui/document/PdfNavigationPanel';
import { buildArtifactContentUrl,artifactVersionKey } from '../../../utils/viewerCache';
import { sha256Hex } from '../../../utils/sha256';
import { workspaceApi,type WorkspaceTarget } from '../../../api/workspace';
import { assertRevision } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

function round2(value:number){return Math.round(value*100)/100}

interface PdfTargetMetaResponse{
  target:{
    pageIndex:number;
    pageCount:number;
    widthPt:number;
    heightPt:number;
    rotate:number;
    pageContentHash:string;
    text:string;
    regionDigest?:string;
  }|null;
}

export function PdfModule({artifact,mode,capabilities,onTarget}:WorkspaceModuleProps){
  const [selection,setSelection]=useState<'page'|'pin'|'region'>('page');
  const [error,setError]=useState('');
  const latest=useRef({key:artifactVersionKey(artifact),mode});
  latest.current={key:artifactVersionKey(artifact),mode};
  const generation=useRef(0);
  const workerReady=capabilities?.operations.some(op=>op.operation==='render_png'&&op.availability==='supported');
  async function capture(pageIndex:number,pageCount:number,selectedText?:PdfTextSelection,readPage?:()=>Promise<string>,location?:PdfLocation){
    if(artifact.revision===undefined)return;
    const identity=latest.current.key,ticket=++generation.current;
    setError('');
    try {
      const pin=Boolean(location&&location.width===0&&location.height===0);
      const rectPt=location
        ?[round2(location.x*location.pageWidth),round2(location.y*location.pageHeight),
          round2(location.width*location.pageWidth),round2(location.height*location.pageHeight)]
        :undefined;
      let pageHash:string|undefined,regionDigest:string|undefined,resolvedPageCount=pageCount,snippet=selectedText?.text;
      let meta:Awaited<ReturnType<typeof workspaceApi.range<PdfTargetMetaResponse>>>|null=null;
      try {
        meta=await workspaceApi.range<PdfTargetMetaResponse>(artifact.id,{
          targetMetadata:'true',
          pageIndex,
          ...(rectPt?{rectPt:JSON.stringify(rectPt)}:{}),
        });
      }catch{/* Fall back to client-side HTTP-safe hashing if metadata endpoint is unavailable in mock harness. */}
      if(meta&&!meta.target)throw Error('ページの構造を確認できません。');
      if(meta?.target){
        assertRevision(artifact,meta);
        pageHash=meta.target.pageContentHash;
        regionDigest=meta.target.regionDigest;
        resolvedPageCount=meta.target.pageCount;
        snippet??=meta.target.text;
      }
      if(!pageHash&&readPage)pageHash=await readPage();
      if(!pageHash)throw Error('ページの内容を識別できません。');
      const selector:WorkspaceTarget['selector']={
        kind:'pdf_page',
        pageIndex,
        expectedPageCount:resolvedPageCount,
        expectedPageContentHash:pageHash,
      };
      let contentCoords:Record<string,unknown>|undefined;
      let regionImagePngBase64:string|undefined;
      if(selectedText){
        const pageText=meta?.target?.text;
        const selected=selectedText.text.replace(/\s+/g,' ').trim();
        const start=pageText?.indexOf(selected)??-1;
        if(!pageText||!selected||start<0||pageText.indexOf(selected,start+1)>=0)throw Error('選択本文をページ内で一意に確認できません。');
        const end=start+selected.length;
        selector.kind='pdf_text_range';
        contentCoords={pageIndex,unit:'pt',quadsPt:selectedText.quadsPt};
        Object.assign(selector,{
          quadsPt:selectedText.quadsPt,
          textOffsetStart:start,textOffsetEnd:end,expectedSnippetHash:sha256Hex(selected),
          contextBeforeHash:sha256Hex(pageText.slice(Math.max(0,start-64),start)),
          contextAfterHash:sha256Hex(pageText.slice(end,end+64)),occurrenceIndex:0,
        });
      }
      if(location&&rectPt){
        selector.kind=pin?'pdf_pin':'pdf_region';
        contentCoords={pageIndex,unit:'pt',...(pin?{xPt:rectPt[0],yPt:rectPt[1]}:{rectPt})};
        const digest=regionDigest??sha256Hex(JSON.stringify([pageHash,rectPt]));
        Object.assign(selector,pin?{xPt:rectPt[0],yPt:rectPt[1]}:{rectPt},{expectedRegionDigest:digest});
        if(workerReady&&!pin){
          try{
            regionImagePngBase64=await workspaceApi.renderRegion(artifact,pageIndex,{x:location.x,y:location.y,width:location.width,height:location.height},'norm');
          }catch{/* A pinned document and its coordinates remain sufficient to create a request. */}
        }
      }
      if(latest.current.key!==identity||latest.current.mode!=='pin'||ticket!==generation.current)return;
      onTarget({baseRevision:artifact.revision,label:'ページ '+(pageIndex+1)+(location?(selector.kind==='pdf_pin'?' / ピン':' / 領域'):selectedText?' / 選択本文':''),
        selectedContentSnapshot:snippet?.slice(0,50_000),selector,contentCoords,regionImagePngBase64});
    }catch(e){
      if(latest.current.key===identity&&ticket===generation.current)setError(e instanceof Error?e.message:'ページを選択できませんでした。');
    }
  }
  return <div className="workspace-page-view">
    {mode==='pin'&&<div className="workspace-toolbar workspace-toolbar-fields" role="group" aria-label="PDF の対象指定">
      <label>対象 <select aria-label="PDF の選択方法" value={selection} onChange={event=>{generation.current++;setSelection(event.target.value as typeof selection)}}>
        <option value="page">ページ・本文</option><option value="pin">ピン</option><option value="region">領域</option>
      </select></label>
      {selection==='region'&&<small>ドラッグ、または矢印キーと Enter で範囲を指定</small>}
    </div>}
    {error&&mode==='pin'&&<p className="error-box" role="alert">{error}</p>}
    <PdfCanvasViewer url={buildArtifactContentUrl(artifact)} documentKey={artifact.id} enhancedNavigation
      selectionMode={mode==='pin'&&selection!=='page'?selection:undefined}
      onSelectLocation={mode==='pin'?(location,readPage)=>void capture(location.pageIndex,location.pageCount,undefined,readPage,location):undefined}
      onSelectPage={mode==='pin'?(index,count,text,readPage)=>void capture(index,count,text,readPage):undefined}/>
  </div>;
}
