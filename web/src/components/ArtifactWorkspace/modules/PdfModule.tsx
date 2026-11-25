import React,{useRef,useState} from 'react';
import { PdfCanvasViewer,type PdfLocation } from '../../shared-ui/document/PdfCanvasCore';
import { buildArtifactContentUrl,artifactVersionKey } from '../../../utils/viewerCache';
import { workspaceApi,type WorkspaceTarget } from '../../../api/workspace';
import { assertRevision } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

async function digest(value:string) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}

export function PdfModule({artifact,mode,capabilities,onTarget}:WorkspaceModuleProps){
  const [selection,setSelection]=useState<'page'|'pin'|'region'>('page');
  const [error,setError]=useState('');
  const latest=useRef({key:artifactVersionKey(artifact),mode});
  latest.current={key:artifactVersionKey(artifact),mode};
  const generation=useRef(0);
  const workerReady=capabilities?.operations.some(op=>op.operation==='read_range'&&op.availability==='supported');
  async function capture(pageIndex:number,pageCount:number,selectedText?:string,readPage?:()=>Promise<string>,location?:PdfLocation){
    if(artifact.revision===undefined)return;
    const identity=latest.current.key,ticket=++generation.current;
    setError('');
    try {
      let pageHash:string|undefined,snippet=selectedText;
      if(workerReady){
        const page=await workspaceApi.range<{pageContentHash:string;text:string}>(artifact.id,{pageIndex});
        assertRevision(artifact,page);pageHash=page.pageContentHash;snippet??=page.text;
      }
      if(!pageHash&&readPage)pageHash=await readPage();
      if(!pageHash)throw Error('ページの内容を識別できません。');
      const selector:WorkspaceTarget['selector']={kind:'pdf_page',pageIndex,expectedPageCount:pageCount,
        expectedPageContentHash:pageHash,expectedArtifactSha256:artifact.sha256};
      let contentCoords:Record<string,unknown>|undefined;
      let regionImagePngBase64:string|undefined;
      if(location){
        const {x,y,width,height,pageWidth,pageHeight}=location;
        const pin=width===0&&height===0;
        const rectPt=[x*pageWidth,y*pageHeight,width*pageWidth,height*pageHeight];
        selector.kind=pin?'pdf_pin':'pdf_region';
        contentCoords={pageIndex,unit:'pt',...(pin?{xPt:rectPt[0],yPt:rectPt[1]}:{rectPt})};
        Object.assign(selector,contentCoords,{expectedRegionDigest:await digest(JSON.stringify([pageHash,rectPt]))});
        if(workerReady&&!pin){
          try{
            const png=await workspaceApi.render(artifact,{pageIndex,regionX:x,regionY:y,regionWidth:width,regionHeight:height,regionUnit:'norm'});
            regionImagePngBase64=await new Promise<string>((resolve,reject)=>{
              const reader=new FileReader();
              reader.onload=()=>resolve(String(reader.result).split(',')[1]);
              reader.onerror=reject;reader.readAsDataURL(png);
            });
          }catch{/* A pinned document and its coordinates remain sufficient to create a request. */}
        }
      }
      if(latest.current.key!==identity||latest.current.mode!=='pin'||ticket!==generation.current)return;
      onTarget({baseRevision:artifact.revision,label:'ページ '+(pageIndex+1)+(location?(selector.kind==='pdf_pin'?' / ピン':' / 領域'):selectedText?' / 選択本文':''),
        selectedContentSnapshot:snippet,selector,contentCoords,regionImagePngBase64});
    }catch(e){
      if(latest.current.key===identity&&ticket===generation.current)setError(e instanceof Error?e.message:'ページを選択できませんでした。');
    }
  }
  return <div className="workspace-page-view">
    {mode==='pin'&&<div className="workspace-toolbar" role="group" aria-label="PDF の対象指定">
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
