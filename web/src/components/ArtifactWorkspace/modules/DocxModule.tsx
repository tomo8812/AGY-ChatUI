import React,{useRef,useState} from 'react';
import type {Editor} from '@tiptap/react';
import {WordParagraphEditor,type WordRun,type WordMark} from '../../shared-ui/editor/WordParagraphEditor';
import { workspaceApi,supportsOperation,type EditOperation } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { PdfCanvasViewer } from '../../shared-ui/document/PdfCanvasCore';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

interface WordBlock {blockIndex:number;type:string;text:string;editableText?:boolean;marks?:Partial<Record<WordMark,boolean>>;uiRuns?:WordRun[]}
interface WordRange {blocks:WordBlock[];blockCount:number;hasMore:boolean}
const PAGE=40;
/** Text edits precede insertion of protected image runs. */
export function prepareDocxOperations(operations:readonly EditOperation[]):EditOperation[]{
  return [...operations].sort((a,b)=>Number(a.op==='docx.add_image')-Number(b.op==='docx.add_image'));
}
export function DocxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,target}:WorkspaceModuleProps){
  const [page,setPage]=useState(0);
  const [reading,setReading]=useState<'page'|'text'>('page');
  const pdfCap=capabilities?.operations.find(op=>op.operation==='export:pdf');
  const canRender=pdfCap?.availability==='supported'||pdfCap?.availability==='partial';
  const [selected,setSelected]=useState<number|null>(null);
  const activeEditor=useRef<Editor|null>(null);
  const imageInput=useRef<HTMLInputElement>(null);
  const latest=useRef(artifact);latest.current=artifact;
  const [imageError,setImageError]=useState('');
  const resource=useRevisionResource(artifact,'docx:'+page,async signal=>{
    const data=await workspaceApi.range<WordRange>(artifact.id,{start:page*PAGE,count:PAGE},signal);
    assertRevision(artifact,data);return data;
  });
  const blocks=resource.data?.blocks??[];
  const block=blocks.find(b=>b.blockIndex===selected);
  const locked=editingLocked||!resource.ready||artifact.revision===undefined;
  const can=(op:string)=>!locked&&supportsOperation(capabilities,op);
  const stage=(key:string,operation:Record<string,unknown>&{op:string},label:string)=>{
    if(artifact.revision!==undefined&&!locked)onDraft(artifact.revision,{key,label,operation},key);
  };
  const styleParagraph=(operation:Record<string,unknown>&{op:string},kind:string)=>{
    if(!block||block.type!=='p'||!can(operation.op))return;
    stage(kind+':'+block.blockIndex,{...operation,blockIndex:block.blockIndex},'段落 '+(block.blockIndex+1)+' の書式');
  };
  const tableDraft=draft?.entries.find(e=>e.key==='new-table');
  const tableRows=tableDraft?.operation.rows as string[][]|undefined;
  const addParagraph=draft?.entries.find(e=>e.key==='new-paragraph');
  const pageControls=<>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!page} onClick={()=>setPage(p=>p-1)}>前の段落</button><span>段落 {page*PAGE+1}–{Math.min((page+1)*PAGE,resource.data?.blockCount??(page+1)*PAGE)}</span>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready||!resource.data?.hasMore} onClick={()=>setPage(p=>p+1)}>次の段落</button>
  </>;
  const primary=<>
    {mode==='view'&&pageControls}
    {mode==='edit'&&<>
      <button type="button" className="btn btn-secondary btn-xs" disabled={locked||!block?.editableText} onMouseDown={e=>e.preventDefault()} onClick={()=>{const ed=activeEditor.current;if(ed&&!ed.isDestroyed&&ed.isEditable)ed.chain().focus().selectAll().run()}}>段落全選択</button>
      {([['bold','太字'],['italic','斜体'],['underline','下線']] as const).map(([mark,label])=><button key={mark} type="button" className="btn btn-secondary btn-xs" disabled={locked||!block?.editableText} onMouseDown={e=>e.preventDefault()} onClick={()=>{const ed=activeEditor.current;if(ed&&!ed.isDestroyed&&ed.isEditable)ed.chain().focus().toggleMark(mark).run()}}>{label}</button>)}
    </>}
    {mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready||!block||artifact.revision===undefined} onClick={()=>{if(resource.ready&&block&&artifact.revision!==undefined)onTarget({baseRevision:artifact.revision,label:'段落 '+(block.blockIndex+1),selector:{kind:'docx_paragraph',blockIndex:block.blockIndex,expectedBlockHash:artifact.sha256},selectedContentSnapshot:block.text})}}>選択段落を対象にする</button>}
  </>;
  const secondary=mode!=='view'?<>{pageControls}{mode==='edit'&&<>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!block?.editableText||!can('docx.set_paragraph_style')} onClick={()=>styleParagraph({op:'docx.set_paragraph_style',headingLevel:1},'style')}>見出し</button>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!block?.editableText||!can('docx.set_list')} onClick={()=>styleParagraph({op:'docx.set_list',listType:'bullet'},'list')}>箇条書き</button>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!can('docx.add_paragraph')||!!addParagraph} onClick={()=>stage('new-paragraph',{op:'docx.add_paragraph',text:''},'段落を追加')}>段落を追加</button>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!can('docx.add_table')||!!tableDraft} onClick={()=>stage('new-table',{op:'docx.add_table',rows:[['',''],['','']]},'表を追加')}>表を追加</button>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!block?.editableText||!can('docx.add_image')||draft?.entries.some(e=>e.key==='image:'+block.blockIndex)} onClick={()=>imageInput.current?.click()}>画像を追加</button>
      <input ref={imageInput} type="file" hidden accept="image/png,image/jpeg" aria-label="画像ファイル" onChange={e=>{
        const file=e.target.files?.[0],index=block?.blockIndex,revision=artifact.revision;
        e.target.value='';
        if(!file||index===undefined||revision===undefined||!can('docx.add_image'))return;
        if(file.size>6_000_000||!['image/png','image/jpeg'].includes(file.type)){setImageError('PNG/JPEG（6 MB以下）を選択してください。');return}
        const reader=new FileReader();
        reader.onload=()=>{
          if(latest.current.id!==artifact.id||latest.current.revision!==revision||typeof reader.result!=='string')return;
          const base64=reader.result.split(',')[1];
          if(base64)onDraft(revision,{key:'image:'+index,label:file.name,operation:{op:'docx.add_image',blockIndex:index,imageBase64:base64}},'image:'+index);
        };reader.onerror=()=>setImageError('画像を読み込めませんでした。');reader.readAsDataURL(file);
      }}/>
    </>}
  </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={1450}/>;
  if(mode==='view'&&reading==='page'&&canRender)return <div className="workspace-page-view">
    <div className="workspace-toolbar"><button className="btn btn-secondary btn-xs" type="button" onClick={()=>setReading('text')}>読取表示</button></div>
    <PdfCanvasViewer enhancedNavigation documentKey={artifact.id} url={buildArtifactContentUrl(artifact,{convertedPdf:true})}/>
  </div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':docx'} controlsTop={<>{mode==='view'&&canRender&&<div className="workspace-toolbar"><button className="btn btn-secondary btn-xs" type="button" onClick={()=>setReading('page')}>ページ表示</button></div>}{toolbar}</>}>
    {imageError&&<p role="alert">{imageError}</p>}
    {resource.error&&<div className="error-box" role="alert">{resource.error}<button onClick={resource.retry}>再試行</button></div>}
    {resource.loading&&resource.data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
    {!resource.data?<div className="workspace-loading">{resource.error?'文書を表示できません。':'読み込み中…'}</div>:<article className="workspace-word" aria-label="文書">
    {blocks.map(b=>{
      const k='paragraph:'+b.blockIndex,entry=draft?.entries.find(e=>e.key===k);
      const original=b.uiRuns??[{text:b.text,originIndex:0,...b.marks}];
      const specs=entry?.operation.runs as WordRun[]|undefined;
      const runs=specs?.map(r=>({...original[r.originIndex??0],...r}))??original;
      const v=runs.map(r=>r.text).join('');
      const active=selected===b.blockIndex||target?.selector.blockIndex===b.blockIndex;
      const editable=mode==='edit'&&b.editableText===true&&supportsOperation(capabilities,'docx.set_paragraph_text');
      const heading=!!draft?.entries.find(e=>e.key==='style:'+b.blockIndex),list=!!draft?.entries.find(e=>e.key==='list:'+b.blockIndex);
      const image=draft?.entries.find(e=>e.key==='image:'+b.blockIndex);
      return <div key={b.blockIndex} className={'workspace-word-block '+(active?'selected ':'')+(heading?'word-heading ':'')+(list?'word-list':'')} onClick={()=>{if(selected!==b.blockIndex)activeEditor.current=null;setSelected(b.blockIndex)}}>
        {b.type==='p'?editable?<WordParagraphEditor label={'段落 '+(b.blockIndex+1)} runs={runs} readOnly={locked} onFocus={ed=>{activeEditor.current=ed;setSelected(b.blockIndex)}} onChange={next=>{
          if(artifact.revision===undefined||locked)return;
          const normalize=(list:WordRun[])=>list.map(r=>({text:r.text,originIndex:r.originIndex??0,bold:!!r.bold,italic:!!r.italic,underline:!!r.underline}));
          const same=JSON.stringify(normalize(next))===JSON.stringify(normalize(original));
          const specs=next.map(r=>{const originIndex=r.originIndex??0,base=original[originIndex]??original[0];const out:WordRun={text:r.text,originIndex};for(const m of ['bold','italic','underline'] as const)if(Boolean(r[m])!==Boolean(base[m]))out[m]=Boolean(r[m]);return out});
          onDraft(artifact.revision,same?null:{key:k,label:'段落 '+(b.blockIndex+1),operation:{op:'docx.set_paragraph_text',blockIndex:b.blockIndex,runs:specs,preserveRunProperties:true}},k);

        }}/>:<p>{v||'\u00a0'}{mode==='edit'&&b.editableText!==true&&<small className="workspace-protected">書式・埋め込み要素を保持</small>}</p>:<div className="workspace-protected">{b.type==='tbl'?'表':'保護された文書要素'} {b.text}</div>}
        {image&&<small className="workspace-protected">追加画像: {image.label}</small>}
      </div>;
    })}
    {mode==='edit'&&addParagraph&&<WordParagraphEditor label="追加段落" runs={(addParagraph.operation.runs as WordRun[]|undefined)??[{text:String(addParagraph.operation.text??'')}]} readOnly={locked} onFocus={()=>{activeEditor.current=null;setSelected(null)}} onChange={runs=>stage('new-paragraph',{op:'docx.add_paragraph',runs:runs.map(({originIndex,...r})=>r)},'段落を追加')}/>}
    {mode==='edit'&&tableRows&&<table className="workspace-word-table"><tbody>{tableRows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c}><input aria-label={'追加表 '+(r+1)+'行 '+(c+1)+'列'} value={cell} readOnly={locked} onChange={e=>stage('new-table',{op:'docx.add_table',rows:tableRows.map((line,i)=>line.map((value,j)=>i===r&&j===c?e.target.value:value))},'表を追加')}/></td>)}</tr>)}</tbody></table>}
    </article>}
  </UnifiedViewerZoomShell>
}
