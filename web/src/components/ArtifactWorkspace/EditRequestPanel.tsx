import React,{useEffect,useState} from 'react';
import type { ArtifactRecord } from '../../types';
import type { EditRequestRecord,WorkspaceTarget } from '../../api/workspace';
import { workspaceApi } from '../../api/workspace';
export function EditRequestPanel({artifact,target,onClear}:{artifact:ArtifactRecord;target:WorkspaceTarget|null;onClear:()=>void}){
  const [instruction,setInstruction]=useState('');
  const [requests,setRequests]=useState<EditRequestRecord[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const c=new AbortController();if(artifact.chatId)void workspaceApi.listRequests(artifact.chatId,artifact.id,c.signal).then(r=>{if(!c.signal.aborted)setRequests(r.requests)},()=>{if(!c.signal.aborted)setError('編集依頼を取得できませんでした。')});return()=>c.abort()},[artifact.chatId,artifact.id,refresh]);
  const create=async()=>{
    if(!artifact.chatId||!target||!instruction.trim()||target.baseRevision!==artifact.revision||busy)return;
    setBusy(true);setError(null);
    try{const res=await workspaceApi.createRequest(artifact.chatId,artifact.id,target,instruction.trim());setRequests(prev=>[...prev,res.request]);setInstruction('');onClear()}
    catch(e){setError(e instanceof Error?e.message:'編集依頼を保存できませんでした。')}finally{setBusy(false)}
  };
  const remove=async(id:string)=>{if(!artifact.chatId||busy)return;setBusy(true);try{await workspaceApi.deleteRequest(artifact.chatId,id);setRefresh(v=>v+1)}catch{setError('編集依頼を削除できませんでした。')}finally{setBusy(false)}};
  return <div className="workspace-edit-requests">
    <h3>編集依頼</h3>
    {target?<><div className="workspace-selection">{target.label}<button type="button" className="btn btn-ghost btn-xs" onClick={onClear}>解除</button></div>
      {target.baseRevision!==artifact.revision?<p className="warn-banner">ファイルが更新されました。対象を選び直してください。</p>:<><label className="field">変更内容<textarea rows={4} maxLength={10000} value={instruction} onChange={e=>setInstruction(e.target.value)}/></label><button className="btn btn-primary btn-sm" type="button" disabled={busy||!instruction.trim()} onClick={()=>void create()}>依頼を追加</button></>}</>:<p className="muted-sm">変更したい範囲を選択してください。</p>}
    {error&&<div className="error-box" role="alert">{error}</div>}
    {requests.map(req=><div className="workspace-request-item" key={req.id}><div>{req.instruction}</div><small>{req.status==='draft'?'未送信':req.status==='applied_unverified'?'確認待ち':req.status==='resolved'?'確認済み':req.status==='sent'?'送信済み':'再確認が必要'}</small>{req.status==='draft'&&<button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={()=>void remove(req.id)}>削除</button>}</div>)}
  </div>;
}
