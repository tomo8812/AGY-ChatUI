import type { ArtifactRecord } from '../../../types';
import { lazy } from 'react';
import type { WorkspaceModule } from '../types';
import type { EditOperation } from '../../../api/workspace';
import { preparePptxOperations } from '../pptxDraft';

const SourceModule=lazy(()=>import('./SourceModule').then(m=>({default:m.SourceModule})));
const GridModule=lazy(()=>import('./GridModule').then(m=>({default:m.GridModule})));
const DocxModule=lazy(()=>import('./DocxModule').then(m=>({default:m.DocxModule})));
const PdfModule=lazy(()=>import('./PdfModule').then(m=>({default:m.PdfModule})));
const PptxModule=lazy(()=>import('./PptxModule').then(m=>({default:m.PptxModule})));

const deferOperation=(op:string)=>(operations:readonly EditOperation[])=>[
  ...operations.filter(operation=>operation.op!==op),
  ...operations.filter(operation=>operation.op===op),
];
const prepareDocxOperations=deferOperation('docx.add_image');

const gridCellOps=new Set(['set_cell','xlsx.set_cell','xlsx.set_formula','xlsx.set_cell_style']);
// The viewport addresses the saved grid. Apply those edits before shifting its coordinates.
const prepareGridOperations=(operations:readonly EditOperation[])=>[
  ...operations.filter(operation=>gridCellOps.has(operation.op)),
  ...operations.filter(operation=>!gridCellOps.has(operation.op)),
];

export function prototypeModuleFor(artifact:ArtifactRecord):WorkspaceModule|null{
  const name=artifact.filename.toLowerCase();
  if(name.endsWith('.pptx'))return {Component:PptxModule,prepareOperations:preparePptxOperations,editOperations:['pptx.set_shape_text','pptx.set_shape_bounds','pptx.set_shape_style','pptx.add_shape','pptx.add_image','pptx.add_table','pptx.set_table_cell','pptx.remove_shape','pptx.add_slide','pptx.remove_slide','pptx.reorder_slide'],canPin:true};
  if(name.endsWith('.pdf'))return {Component:PdfModule,editOperations:[],canPin:true};
  if(name.endsWith('.docx'))return {Component:DocxModule,prepareOperations:prepareDocxOperations,editOperations:['docx.set_paragraph_text','docx.set_table_cell'],canPin:true};
  if(/\.(xlsx|csv|tsv)$/.test(name))return {Component:GridModule,prepareOperations:prepareGridOperations,editOperations:name.endsWith('.xlsx')?['xlsx.set_cell','xlsx.set_formula','xlsx.set_cell_style','xlsx.mutate_rows','xlsx.mutate_columns','xlsx.add_sheet','xlsx.rename_sheet','xlsx.remove_empty_sheet']:['edit'],canPin:true};
  if(artifact.previewKind==='markdown'||artifact.previewKind==='code')return {Component:SourceModule,editOperations:['edit'],canPin:true};
  return null;
}
