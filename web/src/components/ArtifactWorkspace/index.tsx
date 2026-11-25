import React from 'react';
import type { ArtifactRecord } from '../../types';
import { WorkspaceShell } from './WorkspaceShell';
import { SourceModule } from './modules/SourceModule';
import { GridModule } from './modules/GridModule';
import { DocxModule } from './modules/DocxModule';
import { PdfModule } from './modules/PdfModule';
import { PptxModule } from './modules/PptxModule';
import type { WorkspaceModule } from './types';

export function prototypeModuleFor(artifact:ArtifactRecord):WorkspaceModule|null{
  const name=artifact.filename.toLowerCase();
  if(name.endsWith('.pptx'))return {Component:PptxModule,editOperations:['pptx.set_shape_text','pptx.set_shape_bounds'],canPin:true};
  if(name.endsWith('.pdf'))return {Component:PdfModule,editOperations:[],canPin:true};
  if(name.endsWith('.docx'))return {Component:DocxModule,editOperations:['docx.set_paragraph_text'],canPin:true};
  if(/\.(xlsx|csv|tsv)$/.test(name))return {Component:GridModule,editOperations:name.endsWith('.xlsx')?['xlsx.set_cell','xlsx.set_formula','xlsx.set_cell_style','xlsx.mutate_rows','xlsx.mutate_columns','xlsx.add_sheet','xlsx.rename_sheet','xlsx.remove_empty_sheet']:['edit'],canPin:true};
  if(artifact.previewKind==='markdown'||artifact.previewKind==='code')return {Component:SourceModule,editOperations:['edit'],canPin:true};
  return null;
}
export function ArtifactWorkspace({artifact,onClose,onArtifactChanged}:{artifact:ArtifactRecord;onClose:()=>void;onArtifactChanged?:(artifact:ArtifactRecord)=>void}){
  const module=prototypeModuleFor(artifact);
  return module?<WorkspaceShell artifact={artifact} module={module} onClose={onClose} onArtifactChanged={onArtifactChanged}/>:<div role="alert">この形式は未対応です。</div>;
}
