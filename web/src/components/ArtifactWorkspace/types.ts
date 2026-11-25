import type { ComponentType } from 'react';
import type { ArtifactRecord } from '../../types';
import type { EditOperation, WorkspaceCapabilities, WorkspaceTarget } from '../../api/workspace';

export type WorkspaceMode='view'|'edit'|'pin';
export interface DraftEntry {key:string;operation:EditOperation;label:string;displayValue?:string}
export interface WorkspaceDraft {baseRevision:number;entries:DraftEntry[]}
export interface WorkspaceModuleProps {
  artifact:ArtifactRecord;
  mode:WorkspaceMode;
  capabilities:WorkspaceCapabilities|null;
  draft:WorkspaceDraft|null;
  editingLocked:boolean;
  onDraft:(baseRevision:number,entry:DraftEntry|null,key:string)=>void;
  target:WorkspaceTarget|null;
  onTarget:(target:WorkspaceTarget|null)=>void;
}
export interface WorkspaceModule {
  Component:ComponentType<WorkspaceModuleProps>;
  editOperations:readonly string[];
  canPin:boolean;
  /** Prepare a fresh, ordered operation list without mutating the draft. */
  prepareOperations?:(operations:readonly EditOperation[])=>EditOperation[];
}
