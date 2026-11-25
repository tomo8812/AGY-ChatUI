import React from 'react';
import { PdfCanvasViewer } from '../../ArtifactViewerModal';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import type { WorkspaceModuleProps } from '../types';

export function PdfModule({artifact,mode,onTarget}:WorkspaceModuleProps){
  return <PdfCanvasViewer url={buildArtifactContentUrl(artifact)} documentKey={artifact.id}
    onSelectPage={mode==='pin'&&artifact.revision!==undefined ? (pageIndex,pageCount)=>{
      onTarget({baseRevision:artifact.revision!,label:'ページ '+(pageIndex+1),
        selector:{kind:'pdf_page',pageIndex,expectedPageCount:pageCount,expectedArtifactSha256:artifact.sha256}});
    } : undefined}/>;
}
