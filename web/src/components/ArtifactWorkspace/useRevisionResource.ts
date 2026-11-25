import { useEffect, useRef, useState } from 'react';
import type { ArtifactRecord } from '../../types';
import { artifactVersionKey } from '../../utils/viewerCache';
import type { RevisionResponse } from '../../api/workspace';

export function assertRevision(artifact:ArtifactRecord,data:RevisionResponse){
  if(data.artifactId!==artifact.id||data.revision!==artifact.revision||data.sha256!==artifact.sha256)throw Error('ファイルが更新されました。最新の状態を読み直してください。');
}
interface Resource<T>{key:string;data:T|null;error:string|null;loading:boolean}
/** Retain the previous render during refresh; never authorize edits against stale data. */
export function useRevisionResource<T>(artifact:ArtifactRecord,queryKey:string,load:(signal:AbortSignal)=>Promise<T>){
  const key=artifactVersionKey(artifact)+':'+queryKey;
  const latestLoad=useRef(load);latestLoad.current=load;
  const [retry,setRetry]=useState(0);
  const [state,setState]=useState<Resource<T>>({key:'',data:null,error:null,loading:true});
  useEffect(()=>{
    const controller=new AbortController();
    setState(previous=>({...previous,error:null,loading:true}));
    void latestLoad.current(controller.signal).then(data=>{if(!controller.signal.aborted)setState({key,data,error:null,loading:false})},error=>{if(!controller.signal.aborted)setState(previous=>({...previous,key,error:error instanceof Error?error.message:'読み込みに失敗しました。',loading:false,data:null}))});
    return()=>controller.abort();
  },[key,retry]);
  return {...state,loading:state.loading||state.key!==key,ready:state.key===key&&!state.loading&&!state.error&&state.data!==null,retry:()=>setRetry(v=>v+1)};
}
