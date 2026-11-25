import React from 'react';
import type { ArtifactRecord } from '../../types';
import { WorkspaceShell } from './WorkspaceShell';
import { prototypeModuleFor } from './modules/registry';
export { prototypeModuleFor } from './modules/registry';
export function ArtifactWorkspace({artifact,onClose,onArtifactChanged}:{artifact:ArtifactRecord;onClose:()=>void;onArtifactChanged?:(artifact:ArtifactRecord)=>void}){
  const module=prototypeModuleFor(artifact);
  return module?<WorkspaceShell artifact={artifact} module={module} onClose={onClose} onArtifactChanged={onArtifactChanged}/>:<div role="alert">この形式は未対応です。</div>;
}
