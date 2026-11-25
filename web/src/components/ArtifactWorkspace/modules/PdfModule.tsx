import React from 'react';
import { PdfCanvasViewer } from '../../ArtifactViewerModal';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import type { WorkspaceModuleProps } from '../types';
export function PdfModule({artifact}:WorkspaceModuleProps){
  return <PdfCanvasViewer url={buildArtifactContentUrl(artifact)}/>;
}
