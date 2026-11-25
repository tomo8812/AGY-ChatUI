import React,{useEffect,useRef,useState} from 'react';
import type { ArtifactRecord } from '../../types';
import type { EditRequestRecord,WorkspaceTarget } from '../../api/workspace';
import { workspaceApi } from '../../api/workspace';

export function EditRequestPanel({artifact,target,onClear}:{artifact:ArtifactRecord;target:WorkspaceTarget|null;onClear:()=>void}){
  const [instruction,setInstruction]=useState('');
  const [requests,setRequests]=useState<EditRequestRecord[]>([]);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  const [editing,setEditing]=useState<string|null>(null);
  const [editedInstruction,setEditedInstruction]=useState('');
  const alive=useRef(false),mutation=useRef(false);
  const listController=useRef<AbortController|null>(null);
  const latestTarget=useRef(target);latestTarget.current=target;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;listController.current?.abort()}},[]);
  useEffect(()=>{
    const c=new AbortController();listController.current=c;setLoading(true);
    if(artifact.chatId)void workspaceApi.listRequests(artifact.chatId,artifact.id,c.signal).then(r=>{if(!c.signal.aborted)setRequests(r.requests)},()=>{if(!c.signal.aborted)setError('編集依頼を取得できませんでした。')}).finally(()=>{if(!c.signal.aborted)setLoading(false)});
    else setLoading(false);
    return()=>c.abort();
  },[artifact.chatId,artifact.id,artifact.revision,refresh]);
  async function mutate(run:()=>Promise<void>){
    if(!artifact.chatId||mutation.current||loading)return;
    mutation.current=true;setBusy(true);setError(null);listController.current?.abort();
    try{await run();if(alive.current)setRefresh(v=>v+1)}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'編集依頼を更新できませんでした。')}
    finally{mutation.current=false;if(alive.current)setBusy(false)}
  }
  const create=()=>{
    if(!artifact.chatId||!target||!instruction.trim()||target.baseRevision!==artifact.revision)return;
    const selected=target,chatId=artifact.chatId;
    void mutate(async()=>{
      const res=await workspaceApi.createRequest(chatId,artifact.id,selected,instruction.trim());
      if(!alive.current)return;
      setRequests(prev=>[...prev,res.request]);setInstruction('');
      if(latestTarget.current===selected)onClear();
    });
  };
  const update=(id:string)=>{
    if(!artifact.chatId||!editedInstruction.trim())return;
    const chatId=artifact.chatId;
    void mutate(async()=>{
      const res=await workspaceApi.updateRequest(chatId,id,editedInstruction.trim());
      if(!alive.current)return;
      setRequests(prev=>prev.map(req=>req.id===id?res.request:req));setEditing(null);
    });
  };
  const remove=(id:string)=>{
    if(!artifact.chatId)return;
    const chatId=artifact.chatId;
    void mutate(async()=>{await workspaceApi.deleteRequest(chatId,id);if(alive.current){setRequests(prev=>prev.filter(req=>req.id!==id));if(editing===id)setEditing(null)}});
  };
  const resolve=(id:string)=>{
    if(!artifact.chatId||!window.confirm('変更内容を確認済みにしますか？'))return;
    const chatId=artifact.chatId;
    void mutate(async()=>{const result=await workspaceApi.resolveRequest(chatId,id);if(alive.current)setRequests(prev=>prev.map(req=>req.id===id?result.request:req))});
  };
  const drafts=requests.filter(request=>request.status==='draft');
  const reorder=(id:string,offset:number)=>{
    if(!artifact.chatId)return;
    const orderedIds=drafts.map(request=>request.id);
    const index=orderedIds.indexOf(id),swap=index+offset;
    if(index<0||swap<0||swap>=orderedIds.length)return;
    [orderedIds[index],orderedIds[swap]]=[orderedIds[swap],orderedIds[index]];
    const chatId=artifact.chatId;
    void mutate(async()=>{await workspaceApi.reorderRequests(chatId,orderedIds)});
  };
  const disabled=busy||loading;
  return <div className="workspace-edit-requests">
    <h3>編集依頼</h3>
    {target?<><div className="workspace-selection">{target.label}<button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={onClear}>解除</button></div>
      {target.baseRevision!==artifact.revision?<p className="warn-banner">ファイルが更新されました。対象を選び直してください。</p>:<><label className="field">変更内容<textarea rows={4} maxLength={10000} value={instruction} readOnly={busy} onChange={e=>setInstruction(e.target.value)}/></label><button className="btn btn-primary btn-sm" type="button" disabled={disabled||!instruction.trim()} onClick={create}>依頼を追加</button></>}</>:<p className="muted-sm">変更したい範囲を選択してください。</p>}
    {error&&<div className="error-box" role="alert">{error}<button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={()=>{setError(null);setRefresh(v=>v+1)}}>再読込</button></div>}
    {loading&&<p className="muted-xs">読み込み中…</p>}
    {requests.map(req=><div className="workspace-request-item" key={req.id}>
      {editing===req.id?<><label className="field">依頼の修正<textarea rows={3} maxLength={10000} value={editedInstruction} readOnly={busy} onChange={e=>setEditedInstruction(e.target.value)}/></label><div className="workspace-request-actions"><button type="button" className="btn btn-secondary btn-xs" disabled={disabled||!editedInstruction.trim()} onClick={()=>update(req.id)}>修正を保存</button><button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div></>:<div>{req.instruction}</div>}
      <small>{req.status==='draft'?'未送信':req.status==='applied_unverified'?'確認待ち':req.status==='resolved'?'確認済み':req.status==='sent'?'送信済み':'再確認が必要'} · v{req.baseRevision}</small>
      {req.selectedContentSnapshot&&<details className="workspace-request-target"><summary>対象の内容</summary><pre>{req.selectedContentSnapshot}</pre></details>}
      <div className="workspace-request-actions">
        {req.status==='draft'&&editing!==req.id&&<><button type="button" className="btn btn-ghost btn-xs" disabled={disabled} onClick={()=>{setEditing(req.id);setEditedInstruction(req.instruction)}}>指示を修正</button><button type="button" className="btn btn-ghost btn-xs" disabled={disabled||drafts[0]?.id===req.id} onClick={()=>reorder(req.id,-1)}>上へ</button><button type="button" className="btn btn-ghost btn-xs" disabled={disabled||drafts.at(-1)?.id===req.id} onClick={()=>reorder(req.id,1)}>下へ</button><button type="button" className="btn btn-ghost btn-xs" disabled={disabled} onClick={()=>remove(req.id)}>削除</button></>}
        {req.status==='applied_unverified'&&<button type="button" className="btn btn-secondary btn-xs" disabled={disabled} onClick={()=>resolve(req.id)}>変更を確認</button>}
      </div>
    </div>)}
  </div>;
}
