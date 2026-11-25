import React,{useCallback,useEffect,useRef,useState} from 'react';
import type { ArtifactRecord } from '../../types';
import { api,ApiError } from '../../api/client';
import { supportsOperation,workspaceApi,type WorkspaceCapabilities,type WorkspaceTarget } from '../../api/workspace';
import { artifactVersionKey,buildArtifactContentUrl,isStaleArtifactVersion,notifyArtifactUpdated } from '../../utils/viewerCache';
import { ModalDialog } from '../ModalDialog';
import { CloseIcon,DownloadIcon } from '../Icons';
import type { DraftEntry,WorkspaceDraft,WorkspaceMode,WorkspaceModule } from './types';
import { EditRequestPanel } from './EditRequestPanel';
import './workspace.css';

export interface WorkspaceShellProps {artifact:ArtifactRecord;module:WorkspaceModule;onClose:()=>void;onArtifactChanged?:(artifact:ArtifactRecord)=>void}
function newId(){return globalThis.crypto?.randomUUID?.()??String(Date.now())+'-'+Math.random().toString(36).slice(2)}
export function WorkspaceShell(props:WorkspaceShellProps){return <WorkspaceShellInner key={props.artifact.userId+':'+props.artifact.id} {...props}/>}
function WorkspaceShellInner({artifact:incoming,module,onClose,onArtifactChanged}:WorkspaceShellProps){
  const [local,setLocal]=useState(incoming);
  const artifact=isStaleArtifactVersion(local,incoming)?local:incoming;
  const revisionKey=artifactVersionKey(artifact);
  const [mode,setMode]=useState<WorkspaceMode>('view');
  const [caps,setCaps]=useState<WorkspaceCapabilities|null>(null);
  const [capKey,setCapKey]=useState('');
  const capsReady=capKey===revisionKey;
  const [capError,setCapError]=useState<string|null>(null);
  const [draft,setDraft]=useState<WorkspaceDraft|null>(null);
  const [target,setTarget]=useState<WorkspaceTarget|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [conflict,setConflict]=useState(false);
  const [menu,setMenu]=useState(false);
  const [inspector,setInspector]=useState<'details'|'verify'|null>(null);
  const [verification,setVerification]=useState<Awaited<ReturnType<typeof workspaceApi.verify>>|null>(null);
  const pendingAttempt=useRef<{signature:string;key:string}|null>(null);
  const busyRef=useRef(false);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
  const currentArtifact=useRef(artifact);currentArtifact.current=artifact;
  useEffect(()=>{if(!isStaleArtifactVersion(local,incoming))setLocal(incoming)},[incoming]);
  useEffect(()=>{
    const controller=new AbortController();setCapError(null);
    void workspaceApi.capabilities(artifact.id,controller.signal).then(value=>{if(!controller.signal.aborted){setCaps(value);setCapKey(revisionKey)}},()=>{if(!controller.signal.aborted){setCaps(null);setCapKey(revisionKey);setCapError('編集機能を確認できませんでした。')}});
    return()=>controller.abort();
  },[artifact.id,artifact.previewKind,revisionKey]);
  const canEdit=artifact.revision!==undefined&&module.editOperations.some(op=>supportsOperation(caps,op));
  const canPin=Boolean(artifact.chatId&&artifact.revision!==undefined&&caps?.targetPinSupported&&module.canPin);
  const changed=Boolean(draft&&draft.baseRevision!==artifact.revision);
  const close=()=>{if(busy)return;if(!draft||window.confirm('未保存の変更を破棄して閉じますか？'))onClose()};
  const onDraft=useCallback((baseRevision:number,entry:DraftEntry|null,key:string)=>{
    if(busyRef.current||baseRevision!==currentArtifact.current.revision)return;
    setDraft(old=>{
      if(old&&old.baseRevision!==baseRevision)return old;
      const entries=(old?.entries??[]).filter(item=>item.key!==key);
      if(entry)entries.push(entry);
      return entries.length?{baseRevision,entries}:null;
    });
  },[]);
  const refresh=async()=>{
    const result=await api.getArtifact(artifact.id);
    const next=result.artifact;
    if(next.id!==artifact.id||next.userId!==artifact.userId)throw Error('ファイルが見つかりません。');
    if(mounted.current&&!isStaleArtifactVersion(currentArtifact.current,next)){setLocal(next);onArtifactChanged?.(next);notifyArtifactUpdated(next)}
    return next;
  };
  const save=async(expectedRevision=draft?.baseRevision)=>{
    if(!draft||!expectedRevision||busyRef.current||!capsReady||!canEdit)return;
    if(expectedRevision!==artifact.revision){setConflict(true);return}
    busyRef.current=true;setBusy(true);setError(null);
    const ops=draft.entries.map(item=>item.operation);
    // Native paragraph text edits precede insertion of protected image runs.
    // Append-only operations never shift the existing block indices.
    if(/\.docx$/i.test(artifact.filename))ops.sort((a,b)=>Number(a.op==='docx.add_image')-Number(b.op==='docx.add_image'));
    // Match the draft sprite worker: apply text/bounds before styling.
    if(/\.pptx$/i.test(artifact.filename))ops.sort((a,b)=>Number(a.op==='pptx.set_shape_style')-Number(b.op==='pptx.set_shape_style'));
    const signature=JSON.stringify([expectedRevision,ops]);
    if(pendingAttempt.current?.signature!==signature)pendingAttempt.current={signature,key:newId()};
    try{
      const result=await workspaceApi.edit(artifact.id,expectedRevision,ops,pendingAttempt.current.key);
      if(!mounted.current)return;
      if(result.artifact.id!==artifact.id||result.artifact.userId!==artifact.userId)throw Error('保存結果を確認できませんでした。');
      if(!isStaleArtifactVersion(currentArtifact.current,result.artifact)){setLocal(result.artifact);onArtifactChanged?.(result.artifact);notifyArtifactUpdated(result.artifact)}
      setDraft(null);setConflict(false);pendingAttempt.current=null;
    }catch(e){
      if(!mounted.current)return;
      if(e instanceof ApiError&&e.status===409){setConflict(true);try{await refresh()}catch{}}
      else setError(e instanceof Error?e.message:'保存できませんでした。');
    }finally{busyRef.current=false;setBusy(false)}
  };
  const discard=()=>{if(!draft||window.confirm('未保存の変更を破棄しますか？')){setDraft(null);setConflict(false);pendingAttempt.current=null}};
  const changeMode=(value:WorkspaceMode)=>{
    if(value==='pin'&&draft){setError('変更を保存するか破棄してから、編集依頼を追加してください。');return}
    setError(null);setMode(value);setMenu(false);
  };
  const Module=module.Component;
  return <ModalDialog label={artifact.filename} size="artifact-workspace-modal" onClose={close}>
    <div className="artifact-workspace">
      <header className="workspace-header">
        <div className="workspace-filename" title={artifact.filename}>{artifact.filename}</div>
        <div className="workspace-modes" aria-label="ファイル操作" role="group">
          <button type="button" aria-pressed={mode==='view'} onClick={()=>changeMode('view')}>閲覧</button>
          {canEdit&&<button type="button" aria-pressed={mode==='edit'} onClick={()=>changeMode('edit')}>編集</button>}
          {canPin&&<button type="button" aria-pressed={mode==='pin'} onClick={()=>changeMode('pin')}>依頼</button>}
        </div>
        <a className="icon-btn" title="ダウンロード" aria-label="ダウンロード" href={buildArtifactContentUrl(artifact,{download:true})} download={artifact.filename}><DownloadIcon size={17}/></a>
        <div className="workspace-overflow"><button className="icon-btn" type="button" aria-label="その他の操作" aria-expanded={menu} onClick={()=>setMenu(v=>!v)}>…</button>{menu&&<div className="workspace-menu">
          <button type="button" onClick={()=>{setInspector('details');setMenu(false)}}>ファイル詳細</button>
          <button type="button" onClick={()=>{setInspector('verify');setMenu(false);setVerification(null);void workspaceApi.verify(artifact.id).then(setVerification,e=>setError(e instanceof Error?e.message:'検証できませんでした。'))}}>品質検証</button>
          <button type="button" onClick={()=>{setMenu(false);void refresh().catch(e=>setError(e.message))}}>最新を再読込</button>
        </div>}</div>
        <button type="button" className="icon-btn" aria-label="閉じる" onClick={close}><CloseIcon/></button>
      </header>
      {capError&&<div className="warn-banner">{capError}</div>}
      {changed&&<div className="warn-banner workspace-conflict-banner">ファイルが別の操作で更新されました。未保存の変更は保持されています。 <button type="button" className="btn btn-secondary btn-xs" onClick={()=>setConflict(true)}>確認</button></div>}
      {error&&<div className="error-box" role="alert">{error}<button type="button" className="btn btn-ghost btn-xs" onClick={()=>setError(null)}>閉じる</button></div>}
      <div className="workspace-main">
        <div className="workspace-canvas"><Module artifact={artifact} mode={mode} capabilities={caps} draft={draft} editingLocked={busy||changed||!canEdit||!capsReady} onDraft={onDraft} target={target} onTarget={setTarget}/></div>
        {(mode==='pin'||inspector)&&<aside className="workspace-inspector">
          {mode==='pin'?<EditRequestPanel artifact={artifact} target={target} onClear={()=>setTarget(null)}/>:<><div className="row-between"><strong>{inspector==='details'?'ファイル詳細':'品質検証'}</strong><button type="button" className="icon-btn" aria-label="パネルを閉じる" onClick={()=>setInspector(null)}><CloseIcon/></button></div>{inspector==='details'?<dl><dt>名前</dt><dd>{artifact.filename}</dd><dt>種類</dt><dd>{artifact.mimeType}</dd><dt>サイズ</dt><dd>{artifact.sizeBytes.toLocaleString()} B</dd><dt>バージョン</dt><dd>{artifact.revision??'—'}</dd></dl>:verification?<>{verification.revision!==undefined&&verification.revision!==artifact.revision&&<p className="warn-banner">以前のバージョンの検証結果です。</p>}{verification.checks?.map(check=><div key={check.id} className="workspace-check"><strong>{check.status==='passed'?'合格':check.status==='failed'?'不合格':'未確認'}</strong><div>{check.evidence}</div></div>)}{verification.issues.map((issue,i)=><p key={i}>{issue.message}</p>)}</>:<p className="muted-sm">検証中…</p>}</>}
        </aside>}
      </div>
      <footer className="workspace-status">
        <span className="muted-xs">{artifact.revision!==undefined?'バージョン '+artifact.revision:''}</span>
        <span className="muted-xs" role="status">{busy?'保存中…':draft?'未保存の変更 '+draft.entries.length+' 件':'保存済み'}</span>
        {draft&&<><button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={discard}>破棄</button><button type="button" className="btn btn-primary btn-xs" disabled={busy||(!changed&&(!capsReady||!canEdit))} onClick={()=>changed?setConflict(true):void save()}>保存</button></>}
      </footer>
      {conflict&&draft&&<div className="workspace-conflict-dialog" role="alertdialog" aria-label="編集の競合"><div><h3>編集内容が競合しました</h3><p>編集中のバージョン: {draft.baseRevision} ／ 現在: {artifact.revision}</p><ul>{draft.entries.map(e=><li key={e.key}>{e.label}</li>)}</ul><p>変更対象が移動・置換された可能性があるため、自動上書きは行いません。</p><div className="row-actions"><button type="button" className="btn btn-secondary" onClick={()=>setConflict(false)}>変更を保持</button><button type="button" className="btn btn-danger-outline" onClick={()=>{if(window.confirm('変更を破棄して最新を読み込みますか？')){setDraft(null);setConflict(false);void refresh().catch(e=>setError(e.message))}}}>最新を読み直す</button></div></div></div>}
    </div>
  </ModalDialog>;
}
