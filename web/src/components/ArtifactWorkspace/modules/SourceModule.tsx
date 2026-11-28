import {
  PreviewUnavailableFallback,
  TargetInspectionErrorBanner,
  TextRangeTargetControl,
  useRegisteredPinModes,
  type RegisteredUiMode,
} from '../../shared-ui/pin';
import { ResponsiveCommandBar } from '../../shared-ui/layout/ResponsiveCommandBar';
import React,{useDeferredValue,useLayoutEffect,useMemo,useRef,useState} from 'react';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import { MarkdownContent,CodeBlock } from '../../MarkdownContent';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
import { workspaceApi } from '../../../api/workspace';
import { assertRevision } from '../useRevisionResource';
import {SourceEditor,type SourceEditorHandle} from '../../shared-ui/editor/SourceEditor';

export function SourceModule({artifact,capabilities,mode,draft,editingLocked,onDraft,onTarget,beginTargetSelection,jumpTarget}:WorkspaceModuleProps){
  const resource=useRevisionResource(artifact,'source',async signal=>{
    const response=await fetch(buildArtifactContentUrl(artifact),{credentials:'include',signal});
    if(!response.ok)throw Error('ファイルを取得できませんでした。');
    return new TextDecoder('utf-8',{ignoreBOM:true}).decode(await response.arrayBuffer());
  });
  const [query,setQuery]=useState('');
  const [outlineOpen,setOutlineOpen]=useState(false);
  const [outline,setOutline]=useState<{label:string;level:number}[]>([]);
  const preview=useRef<HTMLDivElement>(null);
  const searchOffset=useRef(0);
  const markdown=artifact.previewKind==='markdown';
  const pin=useRegisteredPinModes({
    format:markdown?'markdown':'code',
    filename:artifact.filename,
    previewKind:artifact.previewKind,
    capabilities,
    beginWorkspaceSelection:beginTargetSelection,
    scope:mode,
  });
  const editor=useRef<SourceEditorHandle|null>(null);
  useLayoutEffect(()=>{
    const range=jumpTarget?.range;
    if(!resource.ready||typeof range?.startLine!=='number'||typeof range.endLine!=='number')return;
    if(jumpTarget?.selector.kind==='code_char_range'&&typeof range.startCol==='number'&&typeof range.endCol==='number'){
      editor.current?.selectCharRange(range.startLine,range.startCol,range.endLine,range.endCol);
    }else{
      editor.current?.selectLines(range.startLine,range.endLine);
    }
  },[jumpTarget,resource.ready]);
  const text=resource.data??'';
  const value=String(draft?.entries.find(e=>e.key==='source')?.operation.content??text);
  const previewValue=useDeferredValue(value);
  const language=artifact.filename.includes('.')?(artifact.filename.split('.').pop()??'text'):artifact.filename.toLowerCase();
  const matches=useMemo(()=>{
    const needle=query.toLowerCase();
    if(!needle)return 0;
    const source=value.toLowerCase();
    let count=0;
    for(let index=source.indexOf(needle);index>=0;index=source.indexOf(needle,index+needle.length))count++;
    return count;
  },[query,value]);
  useLayoutEffect(()=>{
    const root=preview.current;if(!root||!markdown||mode==='pin'){setOutline([]);return}
    const update=()=>setOutline(Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(el=>({label:el.textContent??'',level:Number(el.tagName[1])})));
    update();const observer=new MutationObserver(update);observer.observe(root,{childList:true,subtree:true,characterData:true});return()=>observer.disconnect();
  },[resource.data!==null,markdown,mode]);
  function jumpHeading(index:number){preview.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]?.scrollIntoView({block:'nearest',inline:'nearest'});setOutlineOpen(false)}
  function find(){
    if(!query)return;
    if(mode!=='view'){editor.current?.findNext(query);return}
    const root=preview.current;if(!root)return;
    // Search visible rendered text, not raw markdown delimiters or hidden controls.
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('button,script,style,svg,[aria-hidden=true]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    const nodes:Text[]=[];let full='',node:Node|null;
    while((node=walker.nextNode())){nodes.push(node as Text);full+=node.textContent??''}
    const needle=query.toLocaleLowerCase(),hay=full.toLocaleLowerCase();let at=hay.indexOf(needle,searchOffset.current);if(at<0)at=hay.indexOf(needle);if(at<0)return;
    let start:Text|null=null,end:Text|null=null,startOffset=0,endOffset=0,pos=0;
    for(const n of nodes){const len=n.length;if(!start&&at<pos+len){start=n;startOffset=at-pos}if(start&&at+query.length<=pos+len){end=n;endOffset=at+query.length-pos;break}pos+=len}
    if(start&&end&&startOffset>=0&&endOffset<=end.length){const range=document.createRange();range.setStart(start,startOffset);range.setEnd(end,endOffset);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);start.parentElement?.scrollIntoView({block:'nearest',inline:'nearest'});searchOffset.current=at+query.length}
  }
  async function selectLines(targetMode:RegisteredUiMode){
    if(!resource.ready||artifact.revision===undefined||!editor.current)return;
    const characters=targetMode.selectorKind==='code_char_range';
    const bounds=characters?editor.current.getCharacterSelection():editor.current.getSelection();
    if(!bounds){pin.setPinError('対象にする文字を選択してください。');return}
    const {startLine:start,endLine:end}=bounds;
    const isCurrent=pin.selection.begin();
    try{
      const result=await pin.inspectTarget<{text:string;before:string;after:string;expectedSnippetHash:string;contextBeforeHash:string;contextAfterHash:string;occurrenceIndex:number;revision?:number;sha256?:string}>(artifact,{...bounds},targetMode);
      if(!isCurrent())return;
      if(!Number.isInteger(result.occurrenceIndex)||result.occurrenceIndex<0)throw Error('Invalid occurrenceIndex');
      onTarget({baseRevision:artifact.revision,label:characters?start+'–'+end+' 行の選択文字列':start+'–'+end+' 行',selector:{kind:targetMode.selectorKind,...bounds,...(characters?{contextVersion:2}:{}),expectedSnippetHash:result.expectedSnippetHash,contextBeforeHash:result.contextBeforeHash,contextAfterHash:result.contextAfterHash,occurrenceIndex:result.occurrenceIndex},range:{...bounds},selectedContentSnapshot:result.text.slice(0,50_000),surroundingContext:(result.before+'\n---\n'+result.after).slice(0,20_000)});
      pin.clearPinError();
    }catch{if(isCurrent())pin.setPinError('選択対象の識別情報を作成できませんでした。')}
  }
  const primary=mode==='pin'?<>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready} onClick={()=>editor.current?.selectAll()}>全選択</button>
    <TextRangeTargetControl
      modes={pin.modes}
      disabled={!resource.ready}
      onSelectMode={targetMode=>void selectLines(targetMode)}
    />
  </>:<>
    <input className="workspace-command-input" aria-label="検索" placeholder="検索" value={query}
      onChange={e=>{setQuery(e.target.value);searchOffset.current=0}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();find()}}}/>
    {query&&<button type="button" className="btn btn-secondary btn-xs" title={matches+' 件（ソース）'} onClick={find}>次の一致</button>}
    {markdown&&<button type="button" className="btn btn-secondary btn-xs" aria-expanded={outlineOpen} onClick={()=>setOutlineOpen(v=>!v)}>目次</button>}
    {mode==='edit'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready} onClick={()=>editor.current?.selectAll()}>全選択</button>}
  </>;
  const secondary=mode==='edit'&&markdown
    ?[['太字','**','**'],['斜体','*','*'],['見出し','## ',''],['コード','`','`']].map(([label,a,b])=>
      <button key={label} type="button" disabled={editingLocked||!resource.ready} className="btn btn-secondary btn-xs"
        onClick={()=>editor.current?.wrapSelection(a,b)}>{label}</button>)
    :null;
  const tools=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={640}/>;
  const downloadUrl=buildArtifactContentUrl(artifact);
  return <UnifiedViewerZoomShell resetKey={artifact.id+':source'} controlsTop={<>{tools}{outlineOpen&&markdown&&mode!=='pin'&&<nav className="workspace-source-outline" aria-label="文書目次">{outline.length?outline.map((item,index)=><button key={index} type="button" style={{paddingInlineStart:8+(item.level-1)*10}} onClick={()=>jumpHeading(index)}>{item.label}</button>):<span className="muted-xs">見出しがありません。</span>}</nav>}</>}>
    {resource.data!==null&&resource.error&&<TargetInspectionErrorBanner message={resource.error} onRetry={resource.retry}/>}
    {pin.pinError&&<TargetInspectionErrorBanner message={pin.pinError} onDismiss={pin.clearPinError}/>}
    {resource.loading&&<p className="muted-xs">読み込み中…</p>}
    {resource.data===null&&!resource.loading&&resource.error&&(
      <PreviewUnavailableFallback
        reason={resource.error}
        downloadUrl={downloadUrl}
        filename={artifact.filename}
        onRetry={resource.retry}
      />
    )}
    {resource.data!==null&&<div className={'workspace-source'+(markdown&&mode==='edit'?' split':'')}>
      {mode!=='view'?<SourceEditor onSelectionChange={pin.selection.invalidate} editorRef={editor} language={language} value={mode==='pin'?text:value} readOnly={mode!=='edit'||editingLocked||!resource.ready} onChange={content=>{if(artifact.revision!==undefined)onDraft(artifact.revision,content===text?null:{key:'source',label:'ソースの変更',operation:{op:'replace_source',content}},'source')}}/>:null}
      {(mode==='view'||markdown&&mode==='edit')&&<div className="workspace-source-preview" ref={preview}>{markdown?<MarkdownContent content={previewValue} chatId={artifact.chatId}/>:<CodeBlock code={value} language={language}/>}</div>}
    </div>}
  </UnifiedViewerZoomShell>
}
