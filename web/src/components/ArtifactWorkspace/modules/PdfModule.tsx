import { useTargetSelection } from '../useTargetSelection';
import React,{useState} from 'react';
import { PdfCanvasViewer,type PdfLocation } from '../../shared-ui/document/PdfCanvasCore';
import type { PdfTextSelection } from '../../shared-ui/document/PdfNavigationPanel';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import { sha256Hex } from '../../../utils/sha256';
import { workspaceApi,type WorkspaceTarget } from '../../../api/workspace';
import { assertRevision } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

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
    quadsPt?:number[][];
  }|null;
}

export function PdfModule({artifact,mode,onTarget,beginTargetSelection,jumpTarget}:WorkspaceModuleProps){
  const [selection,setSelection]=useState<'page'|'pin'|'region'>('page');
  const [error,setError]=useState('');
  const pinSelection=useTargetSelection(beginTargetSelection,selection);
  async function capture(pageIndex:number,pageCount:number,selectedText?:PdfTextSelection,readPage?:()=>Promise<string>,location?:PdfLocation){
    if(artifact.revision===undefined)return;
    const isCurrent=pinSelection.begin();
    setError('');
    try {
      const pin=Boolean(location&&location.width===0&&location.height===0);
      const rectPt=location
        ?[location.x*location.pageWidth,location.y*location.pageHeight,
          location.width*location.pageWidth,location.height*location.pageHeight]
        :undefined;
      let pageHash:string|undefined,regionDigest:string|undefined,resolvedPageCount=pageCount,snippet=selectedText?.text;
      let meta:Awaited<ReturnType<typeof workspaceApi.range<PdfTargetMetaResponse>>>|null=null;
      try {
        meta=await workspaceApi.range<PdfTargetMetaResponse>(artifact.id,{
          targetMetadata:'true',
          pageIndex,
          ...(selectedText?{textTarget:true,textOffsetStart:selectedText.start,textOffsetEnd:selectedText.end}:{}),
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
      if(selectedText){
        const pageText=meta?.target?.text,quadsPt=meta?.target?.quadsPt;
        const {text:selected,start,end}=selectedText;
        if(!pageText||!quadsPt||!selected||pageText.slice(start,end)!==selected)throw Error('ページ内の選択本文を確認できません。');
        let occurrenceIndex=0;
        for(let offset=pageText.indexOf(selected);offset>=0&&offset<start;offset=pageText.indexOf(selected,offset+1))occurrenceIndex++;
        selector.kind='pdf_text_range';
        contentCoords={pageIndex,unit:'pt',quadsPt};
        Object.assign(selector,{
          quadsPt,
          textOffsetStart:start,textOffsetEnd:end,expectedSnippetHash:sha256Hex(selected),
          contextBeforeHash:sha256Hex(pageText.slice(Math.max(0,start-64),start)),
          contextAfterHash:sha256Hex(pageText.slice(end,end+64)),occurrenceIndex,
        });
      }
      if(location&&rectPt){
        selector.kind=pin?'pdf_pin':'pdf_region';
        contentCoords={pageIndex,unit:'pt',...(pin?{xPt:rectPt[0],yPt:rectPt[1]}:{rectPt})};
        const digest=regionDigest??sha256Hex(JSON.stringify([pageHash,rectPt]));
        Object.assign(selector,pin?{xPt:rectPt[0],yPt:rectPt[1]}:{rectPt},{expectedRegionDigest:digest});

      }
      if(!isCurrent())return;
      onTarget({baseRevision:artifact.revision,label:'ページ '+(pageIndex+1)+(location?(selector.kind==='pdf_pin'?' / ピン':' / 領域'):selectedText?' / 選択本文':''),
        selectedContentSnapshot:snippet?.slice(0,50_000),selector,contentCoords});
    }catch(e){
      if(isCurrent())setError(e instanceof Error?e.message:'ページを選択できませんでした。');
    }
  }
  return <div className="workspace-page-view">
    {mode==='pin'&&<div className="workspace-toolbar workspace-toolbar-fields" role="group" aria-label="PDF の対象指定">
      <label>対象 <select aria-label="PDF の選択方法" value={selection} onChange={event=>{pinSelection.invalidate();setSelection(event.target.value as typeof selection)}}>
        <option value="page">ページ・本文</option><option value="pin">ピン</option><option value="region">領域</option>
      </select></label>
      {selection==='region'&&<small>ドラッグ、または矢印キーと Enter で範囲を指定</small>}
    </div>}
    {error&&mode==='pin'&&<p className="error-box" role="alert">{error}</p>}
    <PdfCanvasViewer jumpLocation={jumpTarget?.coords} url={buildArtifactContentUrl(artifact)} documentKey={artifact.id} enhancedNavigation
      selectionMode={mode==='pin'&&selection!=='page'?selection:undefined}
      onSelectLocation={mode==='pin'?(location,readPage)=>void capture(location.pageIndex,location.pageCount,undefined,readPage,location):undefined}
      onSelectPage={mode==='pin'&&selection==='page'?(index,count,text,readPage)=>void capture(index,count,text,readPage):undefined}/>
  </div>;
}
