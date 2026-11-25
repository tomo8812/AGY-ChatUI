import type { ArtifactRecord } from '../../../types';
import { SourceModule } from './SourceModule';
import { GridModule } from './GridModule';
import { DocxModule } from './DocxModule';
import { PdfModule } from './PdfModule';
import { PptxModule } from './PptxModule';
import type { WorkspaceModule } from '../types';

export function prototypeModuleFor(artifact:ArtifactRecord):WorkspaceModule|null{
  const name=artifact.filename.toLowerCase();
  if(name.endsWith('.pptx'))return {Component:PptxModule,editOperations:['pptx.set_shape_text','pptx.set_shape_bounds','pptx.set_shape_style','pptx.add_shape','pptx.add_image','pptx.add_table','pptx.remove_shape','pptx.add_slide','pptx.remove_slide','pptx.reorder_slide'],canPin:true};
  if(name.endsWith('.pdf'))return {Component:PdfModule,editOperations:[],canPin:true};
  if(name.endsWith('.docx'))return {Component:DocxModule,editOperations:['docx.set_paragraph_text'],canPin:true};
  if(/\.(xlsx|csv|tsv)$/.test(name))return {Component:GridModule,editOperations:name.endsWith('.xlsx')?['xlsx.set_cell','xlsx.set_formula','xlsx.set_cell_style','xlsx.mutate_rows','xlsx.mutate_columns','xlsx.add_sheet','xlsx.rename_sheet','xlsx.remove_empty_sheet']:['edit'],canPin:true};
  if(artifact.previewKind==='markdown'||artifact.previewKind==='code')return {Component:SourceModule,editOperations:['edit'],canPin:true};
  return null;
}
