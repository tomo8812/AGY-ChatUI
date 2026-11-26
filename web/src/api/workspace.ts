import type { ArtifactRecord } from '../types';
import { apiFetch, ApiError, getCsrfToken } from './client';

// safe_image and the slide preview schema accept at most 8,000,000 Base64 characters.
export const MAX_WORKSPACE_IMAGE_BYTES=8_000_000/4*3;

export type WorkspaceFormat='pptx'|'pdf'|'docx'|'xlsx'|'csv'|'markdown'|'code'|'image'|'svg'|'html'|'diff'|'mermaid'|'media'|'binary';
export interface WorkspaceOperationCapability {operation:string;availability:'supported'|'partial'|'disabled_by_resource_tier'|'unsupported_by_format';scope:'mcp_and_ui'|'mcp_only'|'ui_view_only';notes?:string;remediation?:string}
export interface WorkspaceCapabilities {format:WorkspaceFormat;directEditUiSupported:boolean;targetPinSupported:boolean;operations:WorkspaceOperationCapability[]}
export interface WorkspaceTableCellEdit {row:number;column:number;text:string}
export type EditOperation={op:string;[key:string]:unknown};
export interface RevisionResponse {artifactId:string;revision:number;sha256:string}
export interface WorkspaceTarget {selector:{kind:string;[key:string]:unknown};baseRevision:number;label:string;selectedContentSnapshot?:string;surroundingContext?:string;regionImagePngBase64?:string;range?:Record<string,unknown>;contentCoords?:Record<string,unknown>}
export interface EditRequestRecord {id:string;artifactId:string|null;instruction:string;status:string;selector:WorkspaceTarget['selector'];baseRevision:number;selectedContentSnapshot:string}
const path=(id:string,suffix:string)=>'/api/files/'+encodeURIComponent(id)+'/'+suffix;
export interface WorkspaceRevision {
  revision: number;
  sha256: string;
  dependencyManifestHash: string | null;
  sizeBytes: number;
  blobAvailable: boolean;
  previewable: boolean;
  restorable: boolean;
  actorKind: 'user' | 'ai' | 'system';
  operationSummary: string;
  diffPatch: string | null;
  createdAt: number;
}

export const workspaceApi={
  capabilities:(id:string,signal?:AbortSignal)=>apiFetch<WorkspaceCapabilities>(path(id,'capabilities'),{signal}),
  structure:<T extends object>(id:string,signal?:AbortSignal)=>apiFetch<T&RevisionResponse>(path(id,'structure'),{signal}),
  range:<T extends object>(id:string,query:Record<string,string|number|boolean>,signal?:AbortSignal)=>apiFetch<T&RevisionResponse>(path(id,'range')+'?'+new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)])),{signal}),
  xlsxDraftRange:<T extends object>(artifact:ArtifactRecord,body:{sheetName:string;rangeA1:string;operations:EditOperation[]},signal:AbortSignal)=>
    apiFetch<T&RevisionResponse>(path(artifact.id,'xlsx-draft-range'),{method:'POST',signal,body:{...body,expectedRevision:artifact.revision}}),
  async csvCell(artifact:ArtifactRecord,row:number,col:number,signal:AbortSignal):Promise<string>{
    const query=new URLSearchParams({gridCell:'true',startRow:String(row),endRow:String(row),startCol:String(col),endCol:String(col)});
    const res=await fetch(path(artifact.id,'range')+'?'+query,{signal,credentials:'include'});
    if(!res.ok)throw new ApiError(res.status,'CELL_READ_FAILED','セルを読み込めませんでした。');
    if(Number(res.headers.get('X-Artifact-Revision'))!==artifact.revision||res.headers.get('X-Artifact-Sha256')!==artifact.sha256)throw new ApiError(409,'ARTIFACT_CHANGED','ファイルが更新されました。');
    // Response.text strips a leading BOM, which can be literal cell content.
    return new TextDecoder('utf-8',{ignoreBOM:true}).decode(await res.arrayBuffer());
  },
  async render(artifact:ArtifactRecord,query:Record<string,string|number>,signal?:AbortSignal):Promise<Blob>{
    const res=await fetch(path(artifact.id,'render')+'?'+new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)])),{signal,credentials:'include'});
    if(!res.ok)throw new ApiError(res.status,'RENDER_FAILED','描画できませんでした。');
    if(Number(res.headers.get('X-Artifact-Revision'))!==artifact.revision||res.headers.get('X-Artifact-Sha256')!==artifact.sha256)throw new ApiError(409,'ARTIFACT_CHANGED','ファイルが更新されました。');
    if(!res.headers.get('content-type')?.includes('image/png'))throw new Error('画像形式が無効です。');
    return res.blob();
  },
  async renderRegion(artifact:ArtifactRecord,pageIndex:number,rect:{x:number;y:number;width:number;height:number},unit:'norm'|'pt'){
    const blob=await workspaceApi.render(artifact,{
      pageIndex,regionX:rect.x,regionY:rect.y,regionWidth:rect.width,regionHeight:rect.height,regionUnit:unit,
    });
    return new Promise<string>((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(String(reader.result).split(',')[1]);
      reader.onerror=reject;
      reader.readAsDataURL(blob);
    });
  },
  async renderDraftSprite(artifact:ArtifactRecord,query:{pageIndex:number;shapeId:number;cropSprite?:boolean;text?:string;boundsPt?:[number,number,number,number];style?:{bold?:boolean;italic?:boolean;fontSizePt?:number;fontColor?:string;fill?:string};cells?:WorkspaceTableCellEdit[]},signal?:AbortSignal):Promise<Blob>{
    const res=await fetch(path(artifact.id,'render-draft-sprite'),{method:'POST',credentials:'include',signal,
      headers:{'Content-Type':'application/json','x-csrf-token':getCsrfToken()},
      body:JSON.stringify({...query,expectedRevision:artifact.revision})});
    if(!res.ok)throw new ApiError(res.status,'DRAFT_RENDER_FAILED','変更後の描画に失敗しました。');
    if(Number(res.headers.get('X-Artifact-Revision'))!==artifact.revision||res.headers.get('X-Artifact-Sha256')!==artifact.sha256||
      !res.headers.get('content-type')?.includes('image/png'))throw new ApiError(409,'ARTIFACT_CHANGED','ファイルが更新されました。');
    return res.blob();
  },
  async renderDraftSlide(artifact:ArtifactRecord,query:{pageIndex:number;operations:EditOperation[];variant?:'background'|'sprite';draftShapeKey?:string},signal?:AbortSignal):Promise<Blob>{
    const res=await fetch(path(artifact.id,'render-draft-slide'),{method:'POST',credentials:'include',signal,
      headers:{'Content-Type':'application/json','x-csrf-token':getCsrfToken()},
      body:JSON.stringify({...query,expectedRevision:artifact.revision})});
    if(!res.ok)throw new ApiError(res.status,'DRAFT_RENDER_FAILED','変更後の描画に失敗しました。');
    if(Number(res.headers.get('X-Artifact-Revision'))!==artifact.revision||res.headers.get('X-Artifact-Sha256')!==artifact.sha256||
       !res.headers.get('content-type')?.includes('image/png'))throw new ApiError(409,'ARTIFACT_CHANGED','ファイルが更新されました。');
    return res.blob();
  },
  edit(id:string,expectedRevision:number,operations:EditOperation[],idempotencyKey:string){
    const source=operations.length===1&&operations[0].op==='replace_source'&&typeof operations[0].content==='string'
      ? operations[0].content : undefined;
    if(source!==undefined){
      const query=new URLSearchParams({expectedRevision:String(expectedRevision),idempotencyKey});
      return apiFetch<{artifact:ArtifactRecord;noOp:boolean;summary:string}>(path(id,'edit-source')+'?'+query,{method:'POST',textBody:source});
    }
    return apiFetch<{artifact:ArtifactRecord;noOp:boolean;summary:string}>(path(id,'edit'),{method:'POST',body:{expectedRevision,operations,idempotencyKey}});
  },
  listRequests:(chatId:string,artifactId:string,signal?:AbortSignal)=>apiFetch<{requests:EditRequestRecord[]}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests?'+new URLSearchParams({artifactId}),{signal}),
  createRequest:(chatId:string,artifactId:string,target:WorkspaceTarget,instruction:string)=>apiFetch<{request:EditRequestRecord}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests',{method:'POST',body:{
    targetKind:'artifact',artifactId,baseRevision:target.baseRevision,selector:target.selector,range:target.range,contentCoords:target.contentCoords,
    selectedContentSnapshot:target.selectedContentSnapshot,surroundingContext:target.surroundingContext,regionImagePngBase64:target.regionImagePngBase64,instruction,
  }}),
  reorderRequests:(chatId:string,orderedIds:string[])=>apiFetch<{requests:EditRequestRecord[]}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests/reorder',{method:'POST',body:{orderedIds}}),
  updateRequest:(chatId:string,id:string,instruction:string)=>apiFetch<{request:EditRequestRecord}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests/'+encodeURIComponent(id),{method:'PATCH',body:{instruction}}),
  resolveRequest:(chatId:string,id:string)=>apiFetch<{request:EditRequestRecord}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests/'+encodeURIComponent(id)+'/resolve',{method:'POST',body:{}}),
  deleteRequest:(chatId:string,id:string)=>apiFetch<{ok:boolean}>('/api/chats/'+encodeURIComponent(chatId)+'/edit-requests/'+encodeURIComponent(id),{method:'DELETE'}),
  history:(id:string,signal?:AbortSignal)=>apiFetch<{revisions:WorkspaceRevision[]}>(path(id,'history'),{signal}),
  restore:(id:string,targetRevision:number,idempotencyKey:string)=>apiFetch<{artifact:ArtifactRecord}>(
    path(id,'restore'),{method:'POST',body:{targetRevision,idempotencyKey}},
  ),
  exportArtifact:(id:string,targetFormat:string,idempotencyKey:string)=>apiFetch<{artifact:ArtifactRecord}>(
    path(id,'export'),{method:'POST',body:{targetFormat,idempotencyKey}},
  ),
  verify:(id:string)=>apiFetch<{ok:boolean;revision?:number;checks?:Array<{id:string;status:string;evidence:string}>;issues:Array<{severity:string;message:string}>}>(path(id,'verify'),{method:'POST',body:{}}),
};
export function supportsOperation(cap:WorkspaceCapabilities|null,op:string):boolean {
  if(!cap?.directEditUiSupported)return false;
  const capability=cap.operations.find(item=>item.operation===op);
  return Boolean(capability&&capability.scope==='mcp_and_ui'&&(capability.availability==='supported'||capability.availability==='partial'));
}
