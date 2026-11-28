import type { ArtifactRecord } from '../../../types';
import { lazy } from 'react';
import { getRegisteredSelectorsForFormat } from '../../shared-ui/pin';
import type { DraftEntry, WorkspaceModule } from '../types';
import { prepareGridOperations } from '../gridDraft';
import { preparePptxOperations } from '../pptxDraft';

const SourceModule=lazy(()=>import('./SourceModule').then(m=>({default:m.SourceModule})));
const GridModule=lazy(()=>import('./GridModule').then(m=>({default:m.GridModule})));
const DocxModule=lazy(()=>import('./DocxModule').then(m=>({default:m.DocxModule})));
const PdfModule=lazy(()=>import('./PdfModule').then(m=>({default:m.PdfModule})));
const PptxModule=lazy(()=>import('./PptxModule').then(m=>({default:m.PptxModule})));

const prepareDocxOperations=(entries:readonly DraftEntry[])=>{
  const operations=entries.map(entry=>entry.operation);
  return [
    ...operations.filter(operation=>operation.op!=='docx.add_image'),
    ...operations.filter(operation=>operation.op==='docx.add_image'),
  ];
};

const hasRegisteredUiPin=(format:string,artifact:ArtifactRecord)=>
  getRegisteredSelectorsForFormat(format,{filename:artifact.filename,previewKind:artifact.previewKind,uiOnly:true}).length>0;

export function prototypeModuleFor(artifact:ArtifactRecord):WorkspaceModule|null{
  const name=artifact.filename.toLowerCase();
  if(name.endsWith('.pptx'))return {Component:PptxModule,prepareOperations:entries=>preparePptxOperations(entries.map(entry=>entry.operation)),editOperations:['pptx.set_shape_text','pptx.set_shape_bounds','pptx.set_shape_style','pptx.add_shape','pptx.add_image','pptx.add_table','pptx.set_table_cell','pptx.remove_shape','pptx.add_slide','pptx.remove_slide','pptx.reorder_slide'],canPin:hasRegisteredUiPin('pptx',artifact)};
  if(name.endsWith('.pdf'))return {Component:PdfModule,editOperations:[],canPin:hasRegisteredUiPin('pdf',artifact)};
  if(name.endsWith('.docx'))return {Component:DocxModule,prepareOperations:prepareDocxOperations,editOperations:['docx.set_paragraph_text','docx.set_table_cell'],canPin:hasRegisteredUiPin('docx',artifact)};
  if(/\.(xlsx|csv|tsv)$/.test(name)){
    const format=name.endsWith('.xlsx')?'xlsx':'csv';
    return {Component:GridModule,prepareOperations:prepareGridOperations,editOperations:format==='xlsx'?['xlsx.set_cell','xlsx.set_formula','xlsx.set_cell_style','xlsx.mutate_rows','xlsx.mutate_columns','xlsx.add_sheet','xlsx.rename_sheet','xlsx.remove_empty_sheet']:['edit'],canPin:hasRegisteredUiPin(format,artifact)};
  }
  if(artifact.previewKind==='markdown'||artifact.previewKind==='code'){
    return {Component:SourceModule,editOperations:['edit'],canPin:hasRegisteredUiPin(artifact.previewKind,artifact)};
  }
  return null;
}
