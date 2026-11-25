import { useEffect, useRef, useState } from 'react';
import type { ArtifactRecord } from '../../types';
import { artifactVersionKey } from '../../utils/viewerCache';
import type { RevisionResponse } from '../../api/workspace';

export function assertRevision(artifact:ArtifactRecord,data:RevisionResponse){
  if(data.artifactId!==artifact.id||data.revision!==artifact.revision||data.sha256!==artifact.sha256)throw Error('ファイルが更新されました。最新の状態を読み直してください。');
}
interface Resource<T>{key:string;scope:string;data:T|null;error:string|null;loading:boolean}
/** Keep the old geometry while the SAME page/slide/range refreshes.
 * A different query or account must never be rendered as the current selection.
 */
export function useRevisionResource<T>(artifact:ArtifactRecord,queryKey:string,load:(signal:AbortSignal)=>Promise<T>){
  const scope=JSON.stringify([artifact.userId,artifact.id,queryKey]);
  const key=artifactVersionKey(artifact)+':'+scope;
  const latestLoad=useRef(load);latestLoad.current=load;
  const [retry,setRetry]=useState(0);
  const [state,setState]=useState<Resource<T>>({key:'',scope:'',data:null,error:null,loading:true});
  useEffect(()=>{
    const controller=new AbortController();
    setState(previous=>previous.scope===scope?{...previous,error:null,loading:true}:{key:'',scope,data:null,error:null,loading:true});
    void latestLoad.current(controller.signal).then(
      data=>{if(!controller.signal.aborted)setState({key,scope,data,error:null,loading:false})},
      error=>{if(!controller.signal.aborted)setState(previous=>({key,scope,data:previous.scope===scope?previous.data:null,error:error instanceof Error?error.message:'読み込みに失敗しました。',loading:false}))}
    );
    return()=>controller.abort();
  },[key,scope,retry]);
  const current=state.key===key;
  return {data:state.scope===scope?state.data:null,error:current?state.error:null,
    loading:!current||state.loading,ready:current&&!state.loading&&!state.error&&state.data!==null,
    retry:()=>setRetry(v=>v+1)};
}
