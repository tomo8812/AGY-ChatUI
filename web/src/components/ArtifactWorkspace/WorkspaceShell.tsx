import React,{Suspense,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type { ArtifactRecord } from '../../types';
import { api,ApiError } from '../../api/client';
import { supportsOperation,workspaceApi,type EditRequestRecord,type WorkspaceCapabilities,type WorkspaceRevision,type WorkspaceTarget } from '../../api/workspace';
import { artifactVersionKey,buildArtifactContentUrl,isStaleArtifactVersion,notifyArtifactUpdated } from '../../utils/viewerCache';
import { ModalDialog } from '../ModalDialog';
import { CloseIcon,DownloadIcon } from '../Icons';
import type { DraftEntry,WorkspaceDraft,WorkspaceMode,WorkspaceModule, WorkspaceJump } from './types';
import { newRequestId } from '../../utils/requestId';
import { RequestRevisionComparison } from './RequestRevisionComparison';
import { EditRequestPanel } from './EditRequestPanel';
import { PreviewUnavailableFallback } from '../shared-ui/pin';
import './workspace.css';

class WorkspaceErrorBoundary extends React.Component<
  { resetKey: string; filename: string; downloadUrl: string; children: React.ReactNode },
  { error: Error | null; prevResetKey: string }
> {
  state: { error: Error | null; prevResetKey: string } = { error: null, prevResetKey: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; prevResetKey: string },
  ) {
    if (props.resetKey !== state.prevResetKey) return { error: null, prevResetKey: props.resetKey };
    return null;
  }
  render() {
    if (this.state.error) {
      return (
        <PreviewUnavailableFallback
          filename={this.props.filename}
          downloadUrl={this.props.downloadUrl}
          reason={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

export interface WorkspaceShellProps {artifact:ArtifactRecord;module:WorkspaceModule;onClose:()=>void;onArtifactChanged?:(artifact:ArtifactRecord)=>void}
const inspectorLabels={details:'ファイル詳細',verify:'品質検証',history:'バージョン履歴',export:'エクスポート',diff:'差分'} as const;

function historicalArtifact(artifact:ArtifactRecord,version:WorkspaceRevision):ArtifactRecord{
  const {revision,sha256,sizeBytes,dependencyManifestHash}=version;
  return {...artifact,revision,sha256,sizeBytes,dependencyManifestHash};
}
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
  const [jumpTarget,setJumpTarget]=useState<{revisionKey:string;target:WorkspaceJump}|null>(null);
  const [comparison,setComparison]=useState<EditRequestRecord|null>(null);
  const targetGeneration=useRef(0);
  useLayoutEffect(()=>()=>{targetGeneration.current++},[revisionKey,mode]);
  const clearTarget=()=>{targetGeneration.current++;setTarget(null);setJumpTarget(null)};
  const beginTargetSelection=()=>{
    const generation=++targetGeneration.current;
    return ()=>mode==='pin'&&generation===targetGeneration.current;
  };
  const jumpToRequest=async(request:EditRequestRecord)=>{
    if(!artifact.chatId)return;
    const isCurrent=beginTargetSelection();
    try{
      setError(null);
      const result=await workspaceApi.requestLocation(artifact.chatId,request.id);
      if(!isCurrent())return;
      const {request:anchored,reResolution,targetRevision}=result;
      if(anchored.artifactId!==artifact.id||targetRevision!==artifact.revision||reResolution.status!=='resolved'){
        throw Error('対象を特定できませんでした。');
      }
      setJumpTarget({revisionKey,target:{selector:anchored.selector,range:reResolution.resolvedRange,coords:reResolution.resolvedCoords}});
    }catch(e){if(isCurrent())setError(e instanceof Error?e.message:'対象を特定できませんでした。')}
  };
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [conflict,setConflict]=useState(false);
  const [chooseRequestVersion,setChooseRequestVersion]=useState(false);
  const [menu,setMenu]=useState(false);
  const [inspector,setInspector]=useState<keyof typeof inspectorLabels|null>(null);
  const [verification,setVerification]=useState<Awaited<ReturnType<typeof workspaceApi.verify>>|null>(null);
  const [exported,setExported]=useState<ArtifactRecord|null>(null);
  const [exporting,setExporting]=useState(false);
  const exportAttempt=useRef<{signature:string;key:string}|null>(null);
  const exportFormats=capsReady?(caps?.operations??[]).filter(op=>
    op.operation.startsWith('export:')&&op.scope==='mcp_and_ui'&&
    (op.availability==='supported'||op.availability==='partial'),
  ).map(op=>op.operation.slice('export:'.length)):[];
  const [history,setHistory]=useState<WorkspaceRevision[]|null>(null);
  const [historyError,setHistoryError]=useState<string|null>(null);
  const restoreAttempt=useRef<{signature:string;key:string}|null>(null);
  useEffect(()=>{
    if(inspector!=='history')return;
    const controller=new AbortController();
    setHistory(null);setHistoryError(null);
    void workspaceApi.history(artifact.id,controller.signal).then(
      result=>{if(!controller.signal.aborted)setHistory(result.revisions)},
      e=>{if(!controller.signal.aborted)setHistoryError(e instanceof Error?e.message:'履歴を読み込めませんでした。')},
    );
    return()=>controller.abort();
  },[inspector,artifact.id,revisionKey]);
  const canPreviewHistory=artifact.previewKind==='pdf'||artifact.previewKind==='pptx'||
    (exportFormats.includes('pdf')&&(artifact.previewKind==='docx'||/\.xlsx$/i.test(artifact.filename)));
  const textHistoryPreview=artifact.previewKind==='markdown'||artifact.previewKind==='code'||/\.(csv|tsv)$/i.test(artifact.filename);
  const [diffRevision,setDiffRevision]=useState<number|null>(null);
  const [previewVersion,setPreviewVersion]=useState<WorkspaceRevision|null>(null);
  const [previewText,setPreviewText]=useState<{revision:number;text:string;error?:boolean}|null>(null);
  useEffect(()=>{
    if(inspector!=='history'||!previewVersion||!textHistoryPreview)return;
    const controller=new AbortController();
    const url=buildArtifactContentUrl(historicalArtifact(artifact,previewVersion));
    void fetch(url,{credentials:'include',headers:previewVersion.sizeBytes>65536?{Range:'bytes=0-65535'}:undefined,signal:controller.signal})
      .then(response=>{
        if(!response.ok||response.headers.get('X-Artifact-Revision')!==String(previewVersion.revision))throw Error('プレビューを読み込めませんでした。');
        return response.text();
      }).then(text=>{if(!controller.signal.aborted)setPreviewText({revision:previewVersion.revision,text})},
        ()=>{if(!controller.signal.aborted)setPreviewText({revision:previewVersion.revision,text:'プレビューを読み込めませんでした。',error:true})});
    return()=>controller.abort();
  },[inspector,artifact.id,previewVersion,textHistoryPreview]);
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
  const selectorCapabilities = caps?.operations.filter(item => item.operation.startsWith('target_pin:')) ?? [];
  const canPin = Boolean(artifact.chatId && artifact.revision !== undefined && caps?.targetPinSupported && module.canPin &&
    (!selectorCapabilities.length || selectorCapabilities.some(item => item.scope === 'mcp_and_ui' && item.availability === 'supported')));
  const changed=Boolean(draft&&draft.baseRevision!==artifact.revision);
  const close=()=>{if(busy)return;if(!draft||window.confirm('未保存の変更を破棄して閉じますか？'))onClose()};
  const onDraft=useCallback((baseRevision:number,entry:DraftEntry|null,key:string)=>{
    if(busyRef.current||baseRevision!==currentArtifact.current.revision)return;
    setDraft(old=>{
      if(old&&old.baseRevision!==baseRevision)return old;
      const entries=[...(old?.entries??[])];
      const index=entries.findIndex(item=>item.key===key);
      if(index>=0){if(entry)entries[index]=entry;else entries.splice(index,1);}
      else if(entry)entries.push(entry);
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
    const ops=module.prepareOperations?.(draft.entries)??draft.entries.map(item=>item.operation);
    const signature=JSON.stringify([expectedRevision,ops]);
    try{
      if(pendingAttempt.current?.signature!==signature)pendingAttempt.current={signature,key:newRequestId()};
      const result=await workspaceApi.edit(artifact.id,expectedRevision,ops,pendingAttempt.current.key);
      if(!mounted.current)return;
      if(result.artifact.id!==artifact.id||result.artifact.userId!==artifact.userId)throw Error('保存結果を確認できませんでした。');
      if(!isStaleArtifactVersion(currentArtifact.current,result.artifact)){setLocal(result.artifact);onArtifactChanged?.(result.artifact);notifyArtifactUpdated(result.artifact)}
      setDraft(null);setConflict(false);pendingAttempt.current=null;
      return true;
    }catch(e){
      if(!mounted.current)return;
      if(e instanceof ApiError&&e.status===409){setConflict(true);try{await refresh()}catch{}}
      else setError(e instanceof Error?e.message:'保存できませんでした。');
    }finally{busyRef.current=false;setBusy(false)}
  };
  const discard=()=>{if(!draft||window.confirm('未保存の変更を破棄しますか？')){setDraft(null);setConflict(false);pendingAttempt.current=null}};
  const changeMode=(value:WorkspaceMode)=>{
    if(value==='pin'&&draft&&mode!=='pin'){setChooseRequestVersion(true);return}
    if(value!==mode)clearTarget();
    setError(null);setMode(value);setMenu(false);
  };
  const restoreVersion=async(revision:WorkspaceRevision)=>{
    if(busyRef.current||!revision.restorable||revision.revision===artifact.revision)return;
    const confirmation='バージョン '+revision.revision+' を新しいバージョンとして復元しますか？';
    if(!window.confirm(confirmation+(draft?' 未保存の変更は保持されます。':'')))return;
    busyRef.current=true;setBusy(true);setError(null);
    const signature=JSON.stringify([revisionKey,revision.revision]);
    try{
      if(restoreAttempt.current?.signature!==signature)restoreAttempt.current={signature,key:newRequestId()};
      const {artifact:next}=await workspaceApi.restore(artifact.id,revision.revision,restoreAttempt.current.key);
      if(!mounted.current)return;
      if(next.id!==artifact.id||next.userId!==artifact.userId)throw Error('復元結果を確認できませんでした。');
      if(!isStaleArtifactVersion(currentArtifact.current,next)){
        setLocal(next);onArtifactChanged?.(next);notifyArtifactUpdated(next);
      }
      restoreAttempt.current=null;
    }catch(e){
      if(mounted.current)setError(e instanceof Error?e.message:'復元できませんでした。');
    }finally{
      busyRef.current=false;setBusy(false);
    }
  };
  const exportFile=async(format:string)=>{
    if(exporting||!exportFormats.includes(format))return;
    const signature=JSON.stringify([revisionKey,format]);
    setExporting(true);setExported(null);setError(null);
    try{
      if(exportAttempt.current?.signature!==signature)exportAttempt.current={signature,key:newRequestId()};
      const result=await workspaceApi.exportArtifact(artifact.id,format,exportAttempt.current.key);
      if(mounted.current){setExported(result.artifact);exportAttempt.current=null}
    }catch(e){
      if(mounted.current)setError(e instanceof Error?e.message:'エクスポートできませんでした。');
    }finally{
      if(mounted.current)setExporting(false);
    }
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
          <button type="button" onClick={()=>{setInspector('history');if(mode==='pin')setMode('view');setMenu(false)}}>バージョン履歴</button>
          {artifact.diffPatch&&<button type="button" onClick={()=>{setInspector('diff');if(mode==='pin')setMode('view');setMenu(false)}}>差分を表示</button>}
          {exportFormats.length>0&&<button type="button" onClick={()=>{setInspector('export');if(mode==='pin')setMode('view');setMenu(false)}}>エクスポート</button>}
          <button type="button" onClick={()=>{setInspector('verify');setMenu(false);setVerification(null);void workspaceApi.verify(artifact.id).then(setVerification,e=>setError(e instanceof Error?e.message:'検証できませんでした。'))}}>品質検証</button>
          <button type="button" onClick={()=>{setMenu(false);void refresh().catch(e=>setError(e.message))}}>最新を再読込</button>
        </div>}</div>
        <button type="button" className="icon-btn" aria-label="閉じる" onClick={close}><CloseIcon/></button>
      </header>
      {capError&&<div className="warn-banner">{capError}</div>}
      {changed&&<div className="warn-banner workspace-conflict-banner">ファイルが別の操作で更新されました。未保存の変更は保持されています。 <button type="button" className="btn btn-secondary btn-xs" onClick={()=>setConflict(true)}>確認</button></div>}
      {error&&<div className="error-box" role="alert">{error}<button type="button" className="btn btn-ghost btn-xs" onClick={()=>setError(null)}>閉じる</button></div>}
      <div className="workspace-main">
        <div className="workspace-canvas"><WorkspaceErrorBoundary resetKey={revisionKey} filename={artifact.filename} downloadUrl={buildArtifactContentUrl(artifact,{download:true})}><Suspense fallback={<p role="status">読み込み中…</p>}><Module artifact={artifact} mode={mode} capabilities={caps} draft={mode==='pin'?null:draft} editingLocked={busy||changed||!canEdit||!capsReady} onDraft={onDraft} target={target} onTarget={setTarget} beginTargetSelection={beginTargetSelection} jumpTarget={mode==='pin'&&jumpTarget?.revisionKey===revisionKey?jumpTarget.target:undefined}/></Suspense></WorkspaceErrorBoundary></div>
        {(mode==='pin'||inspector)&&<aside className="workspace-inspector">
          {mode==='pin'?<EditRequestPanel artifact={artifact} target={target} onClear={clearTarget} onJump={request=>void jumpToRequest(request)} onCompare={setComparison}/>:<><div className="row-between"><strong>{inspector&&inspectorLabels[inspector]}</strong><button type="button" className="icon-btn" aria-label="パネルを閉じる" onClick={()=>{setInspector(null);setPreviewVersion(null);setPreviewText(null);setDiffRevision(null)}}><CloseIcon/></button></div>{inspector==='details'?<dl><dt>名前</dt><dd>{artifact.filename}</dd><dt>種類</dt><dd>{artifact.mimeType}</dd><dt>サイズ</dt><dd>{artifact.sizeBytes.toLocaleString()} B</dd><dt>バージョン</dt><dd>{artifact.revision??'—'}</dd></dl>:inspector==='diff'?<pre className="workspace-history-source">{artifact.diffPatch}</pre>:inspector==='history'?<>
            {historyError?<p role="alert">{historyError}</p>:!history?<p role="status">読み込み中…</p>:history.length===0?<p>履歴がありません。</p>:
              history.map(version=><div key={version.revision} className="workspace-check">
                <strong>バージョン {version.revision}{version.revision===artifact.revision?'（現在）':''}</strong>
                <div>{({user:'ユーザー',ai:'AI',system:'システム'})[version.actorKind]} · {new Date(version.createdAt).toLocaleString()}</div>
                {version.operationSummary&&<div>{version.operationSummary}</div>}
                {version.previewable&&canPreviewHistory&&<a
                  href={buildArtifactContentUrl(historicalArtifact(artifact,version),{convertedPdf:true})}
                  target="_blank" rel="noopener noreferrer">プレビュー</a>}
                {version.previewable&&textHistoryPreview&&<button type="button" className="btn btn-secondary btn-xs"
                  aria-expanded={previewVersion?.revision===version.revision}
                  onClick={()=>{setDiffRevision(null);setPreviewText(null);setPreviewVersion(previewVersion?.revision===version.revision?null:version)}}>プレビュー</button>}
                {version.diffPatch&&<button type="button" className="btn btn-secondary btn-xs" aria-expanded={diffRevision===version.revision}
                  onClick={()=>{setPreviewVersion(null);setDiffRevision(diffRevision===version.revision?null:version.revision)}}>差分</button>}
                {version.blobAvailable&&<a href={buildArtifactContentUrl(historicalArtifact(artifact,version),{download:true})} download={artifact.filename}>ダウンロード</a>}
                {version.restorable&&version.revision!==artifact.revision&&<button type="button" className="btn btn-secondary btn-xs"
                  disabled={busy} onClick={()=>void restoreVersion(version)}>復元</button>}
                {diffRevision===version.revision&&version.diffPatch&&<pre className="workspace-history-source">{version.diffPatch}</pre>}
                {previewVersion?.revision===version.revision&&(previewText?.revision===version.revision
                  ? previewText.error?<p role="alert">{previewText.text}</p>:<>
                    <pre className="workspace-history-source">{previewText.text}</pre>
                    {version.sizeBytes>65536&&<small>先頭 64 KiB を表示しています。</small>}
                  </>:<p role="status">読み込み中…</p>)}
              </div>)}
          </>:inspector==='export'?<>
            {draft&&<p>保存済みのバージョン {artifact.revision} を変換します。</p>}
            {exportFormats.map(format=><button type="button" key={format} className="btn btn-secondary btn-xs" disabled={exporting||busy}
              onClick={()=>void exportFile(format)}>{format.toUpperCase()}</button>)}
            {exporting&&<p role="status">変換中…</p>}
            {exported&&<p><a href={buildArtifactContentUrl(exported,{download:true})} download={exported.filename}>{exported.filename} をダウンロード</a></p>}
          </>:verification?<>{verification.revision!==undefined&&verification.revision!==artifact.revision&&<p className="warn-banner">以前のバージョンの検証結果です。</p>}{verification.checks?.map(check=><div key={check.id} className="workspace-check"><strong>{check.status==='passed'?'合格':check.status==='failed'?'不合格':'未確認'}</strong><div>{check.evidence}</div></div>)}{verification.issues.map((issue,i)=><p key={i}>{issue.message}</p>)}</>:<p className="muted-sm">検証中…</p>}</>}
        </aside>}
      </div>
      <footer className="workspace-status">
        <span className="muted-xs">{artifact.revision!==undefined?'バージョン '+artifact.revision:''}</span>
        <span className="muted-xs" role="status">{busy?'保存中…':draft?'未保存の変更 '+draft.entries.length+' 件':'保存済み'}</span>
        {draft&&<><button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={discard}>破棄</button><button type="button" className="btn btn-primary btn-xs" disabled={busy||(!changed&&(!capsReady||!canEdit))} onClick={()=>changed?setConflict(true):void save()}>保存</button></>}
      </footer>
      {comparison&&<RequestRevisionComparison artifact={artifact} request={comparison} onClose={()=>setComparison(null)}/>}
      {chooseRequestVersion&&<ModalDialog label="依頼するバージョン" size="workspace-request-version" onClose={()=>{if(!busy)setChooseRequestVersion(false)}}>
        <div><h3>依頼するバージョン</h3><p>保存済みのバージョン {artifact.revision} に依頼する場合も、未保存の変更は保持されます。</p>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" disabled={busy||changed||!capsReady||!canEdit} onClick={async()=>{
              if(await save()){setChooseRequestVersion(false);setTarget(null);setMode('pin')}
              else setChooseRequestVersion(false);
            }}>先に保存して依頼</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setChooseRequestVersion(false);setError(null);setTarget(null);setMode('pin')}}>保存済み版へ依頼</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>setChooseRequestVersion(false)}>取消</button>
          </div>
        </div>
      </ModalDialog>}
      {conflict&&draft&&<div className="workspace-conflict-dialog" role="alertdialog" aria-label="編集の競合"><div><h3>編集内容が競合しました</h3><p>編集中のバージョン: {draft.baseRevision} ／ 現在: {artifact.revision}</p><ul>{draft.entries.map(e=><li key={e.key}>{e.label}</li>)}</ul><p>変更対象が移動・置換された可能性があるため、自動上書きは行いません。</p><div className="row-actions"><button type="button" className="btn btn-secondary" onClick={()=>setConflict(false)}>変更を保持</button><button type="button" className="btn btn-danger-outline" onClick={()=>{if(window.confirm('変更を破棄して最新を読み込みますか？')){setDraft(null);setConflict(false);void refresh().catch(e=>setError(e.message))}}}>最新を読み直す</button></div></div></div>}
    </div>
  </ModalDialog>;
}
