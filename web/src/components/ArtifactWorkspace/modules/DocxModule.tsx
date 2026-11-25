import React,{useState} from 'react';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

interface WordBlock {blockIndex:number;type:string;text:string;editableText?:boolean}
interface WordRange {blocks:WordBlock[];blockCount:number;hasMore:boolean}
const PAGE=40;
export function DocxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,target}:WorkspaceModuleProps){
  const [page,setPage]=useState(0);
  const [selected,setSelected]=useState<number|null>(null);
  const resource=useRevisionResource(artifact,'docx:'+page,async signal=>{
    const data=await workspaceApi.range<WordRange>(artifact.id,{start:page*PAGE,count:PAGE},signal);
    assertRevision(artifact,data);return data;
  });
  const blocks=resource.ready?resource.data?.blocks??[]:[];
  const block=blocks.find(b=>b.blockIndex===selected);
  const toolbar=<div className="workspace-toolbar">
    <button type="button" className="btn btn-secondary btn-xs" disabled={!page} onClick={()=>setPage(p=>p-1)}>前の段落</button><span>段落 {page*PAGE+1}–{Math.min((page+1)*PAGE,resource.data?.blockCount??(page+1)*PAGE)}</span>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready||!resource.data?.hasMore} onClick={()=>setPage(p=>p+1)}>次の段落</button>
    {mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!block||artifact.revision===undefined} onClick={()=>{if(block&&artifact.revision!==undefined)onTarget({baseRevision:artifact.revision,label:'段落 '+(block.blockIndex+1),selector:{kind:'docx_paragraph',blockIndex:block.blockIndex,expectedBlockHash:artifact.sha256},selectedContentSnapshot:block.text})}}>選択段落を対象にする</button>}
  </div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':docx'} controlsTop={toolbar}>
    {resource.error&&<div className="error-box" role="alert">{resource.error}<button onClick={resource.retry}>再試行</button></div>}
    {!resource.ready?<div className="workspace-loading">読み込み中…</div>:<article className="workspace-word" aria-label="文書">
    {blocks.map(b=>{const k='paragraph:'+b.blockIndex;const v=String(draft?.entries.find(e=>e.key===k)?.operation.text??b.text);const active=selected===b.blockIndex||target?.selector.blockIndex===b.blockIndex;const editable=mode==='edit'&&b.editableText===true&&supportsOperation(capabilities,'docx.set_paragraph_text');return <div key={b.blockIndex} className={'workspace-word-block '+(active?'selected':'')} onClick={()=>setSelected(b.blockIndex)}>
      {b.type==='p'?editable?<textarea aria-label={'段落 '+(b.blockIndex+1)} value={v} rows={Math.max(2,Math.min(10,Math.ceil(v.length/75)+1))} maxLength={20000} readOnly={editingLocked} onFocus={()=>setSelected(b.blockIndex)} onChange={e=>{if(artifact.revision!==undefined)onDraft(artifact.revision,e.target.value===b.text?null:{key:k,label:'段落 '+(b.blockIndex+1),operation:{op:'docx.set_paragraph_text',blockIndex:b.blockIndex,text:e.target.value}},k)}}/>:<p>{v||'\u00a0'}{mode==='edit'&&b.editableText!==true&&<small className="workspace-protected">書式・埋め込み要素を保持</small>}</p>:<div className="workspace-protected">{b.type==='tbl'?'表':'保護された文書要素'} {b.text}</div>}
    </div>})}
    </article>}
  </UnifiedViewerZoomShell>
}
