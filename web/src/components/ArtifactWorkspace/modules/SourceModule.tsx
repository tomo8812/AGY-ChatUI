import React,{useRef,useState} from 'react';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import { MarkdownContent,CodeBlock } from '../../MarkdownContent';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
import { sha256Text } from '../targetHash';
import {SourceEditor,type SourceEditorHandle} from '../../shared-ui/editor/SourceEditor';

export function SourceModule({artifact,mode,draft,editingLocked,onDraft,onTarget}:WorkspaceModuleProps){
  const resource=useRevisionResource(artifact,'source',async signal=>{
    if(artifact.sizeBytes>4*1024*1024)throw Error('編集表示は4 MBまで対応しています。');
    const response=await fetch(buildArtifactContentUrl(artifact),{credentials:'include',signal});
    if(!response.ok)throw Error('ファイルを取得できませんでした。');
    return response.text();
  });
  const [query,setQuery]=useState('');
  const [pinError,setPinError]=useState('');
  const editor=useRef<SourceEditorHandle|null>(null);
  const text=resource.data??'';
  const value=String(draft?.entries.find(e=>e.key==='source')?.operation.content??text);
  const markdown=artifact.previewKind==='markdown';
  const language=artifact.filename.split('.').pop()??'text';
  const matches=query?value.toLowerCase().split(query.toLowerCase()).length-1:0;
  async function selectLines(){
    if(!resource.ready||artifact.revision===undefined||!editor.current)return;
    const {startLine:start,endLine:end}=editor.current.getSelection();
    const lines=text.replace(/\r\n/g,'\n').split('\n');
    const snippet=lines.slice(start-1,end).join('\n');
    const before=lines.slice(Math.max(0,start-3),start-1).join('\n');
    const after=lines.slice(end,end+2).join('\n');
    try{
      const [expectedSnippetHash,contextBeforeHash,contextAfterHash]=await Promise.all([sha256Text(snippet),sha256Text(before),sha256Text(after)]);
      onTarget({baseRevision:artifact.revision,label:start+'–'+end+' 行',selector:{kind:markdown?'md_text_range':'code_line_range',startLine:start,endLine:end,expectedSnippetHash,contextBeforeHash,contextAfterHash},range:{startLine:start,endLine:end},selectedContentSnapshot:snippet,surroundingContext:before+'\n---\n'+after});
      setPinError('');
    }catch{setPinError('選択対象の識別情報を作成できませんでした。')}
  }
  const tools=<div className="workspace-toolbar"><input aria-label="検索" placeholder="検索" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<small>{matches} 件</small>}{mode==='edit'&&markdown&&<>{[['太字','**','**'],['斜体','*','*'],['見出し','## ',''],['コード','`','`']].map(([label,a,b])=><button key={label} type="button" disabled={editingLocked||!resource.ready} className="btn btn-secondary btn-xs" onClick={()=>editor.current?.wrapSelection(a,b)}>{label}</button>)}</>}{mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready} onClick={()=>void selectLines()}>選択行を対象にする</button>}</div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':source'} controlsTop={tools}>
    {resource.error&&<div className="error-box" role="alert">{resource.error}<button type="button" onClick={resource.retry}>再試行</button></div>}
    {pinError&&<div role="alert">{pinError}</div>}
    {resource.loading&&<p className="muted-xs">読み込み中…</p>}
    {resource.data!==null&&<div className={'workspace-source'+(markdown&&mode==='edit'?' split':'')}>
      {mode!=='view'?<SourceEditor editorRef={editor} language={language} value={mode==='pin'?text:value} readOnly={mode!=='edit'||editingLocked||!resource.ready} onChange={content=>{if(artifact.revision!==undefined)onDraft(artifact.revision,content===text?null:{key:'source',label:'ソースの変更',operation:{op:'replace_source',content}},'source')}}/>:null}
      {(mode==='view'||markdown&&mode==='edit')&&(markdown?<MarkdownContent content={value} chatId={artifact.chatId}/>:<CodeBlock code={value} language={language}/>)}
    </div>}
  </UnifiedViewerZoomShell>
}
