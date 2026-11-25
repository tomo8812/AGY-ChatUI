import React from 'react';
import { PdfCanvasViewer } from '../../shared-ui/document/PdfCanvasCore';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import type { WorkspaceModuleProps } from '../types';

export function PdfModule({artifact,mode,onTarget}:WorkspaceModuleProps){
  return <PdfCanvasViewer url={buildArtifactContentUrl(artifact)} documentKey={artifact.id} enhancedNavigation
    onSelectPage={mode==='pin'&&artifact.revision!==undefined ? (pageIndex,pageCount,selectedText)=>{
      onTarget({baseRevision:artifact.revision!,label:'ページ '+(pageIndex+1)+(selectedText?' / 選択本文':''),selectedContentSnapshot:selectedText,
        selector:{kind:'pdf_page',pageIndex,expectedPageCount:pageCount,expectedArtifactSha256:artifact.sha256}});
    } : undefined}/>;
}
