import React from 'react';
import { PdfCanvasViewer, type PdfLocation } from '../../shared-ui/document/PdfCanvasCore';
import {
  PinModeToolbar,
  TargetInspectionErrorBanner,
  useRegisteredPinModes,
} from '../../shared-ui/pin';
import { buildArtifactContentUrl } from '../../../utils/viewerCache';
import { sha256Hex } from '../../../utils/sha256';
import { workspaceApi, type WorkspaceTarget } from '../../../api/workspace';
import { assertRevision } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

interface PdfTargetMetaResponse {
  target: {
    pageIndex: number;
    pageCount: number;
    widthPt: number;
    heightPt: number;
    rotate: number;
    pageContentHash: string;
    text: string;
    regionDigest?: string;
  } | null;
}

export function PdfModule({ artifact, mode, capabilities, onTarget, beginTargetSelection, jumpTarget }: WorkspaceModuleProps) {
  const pin = useRegisteredPinModes({
    format: 'pdf',
    filename: artifact.filename,
    previewKind: artifact.previewKind,
    capabilities,
    beginWorkspaceSelection: beginTargetSelection,
  });

  async function capture(pageIndex: number, pageCount: number, readPage?: () => Promise<string>, location?: PdfLocation) {
    if (artifact.revision === undefined) return;
    const isCurrent = pin.selection.begin();
    pin.clearPinError();
    try {
      const isPoint = Boolean(location && location.width === 0 && location.height === 0);
      const rectPt = location
        ? [
            location.x * location.pageWidth,
            location.y * location.pageHeight,
            location.width * location.pageWidth,
            location.height * location.pageHeight,
          ]
        : undefined;
      let pageHash: string | undefined;
      let regionDigest: string | undefined;
      let resolvedPageCount = pageCount;
      let snippet: string | undefined;
      let meta: Awaited<ReturnType<typeof workspaceApi.range<PdfTargetMetaResponse>>> | null = null;
      try {
        meta = await workspaceApi.range<PdfTargetMetaResponse>(artifact.id, {
          targetMetadata: 'true',
          pageIndex,
          ...(rectPt ? { rectPt: JSON.stringify(rectPt) } : {}),
        });
      } catch {
        // Fall back to client-side HTTP-safe hashing if metadata endpoint is unavailable in mock harness.
      }
      if (meta && !meta.target) throw Error('ページの構造を確認できません。');
      if (meta?.target) {
        assertRevision(artifact, meta);
        pageHash = meta.target.pageContentHash;
        regionDigest = meta.target.regionDigest;
        resolvedPageCount = meta.target.pageCount;
        snippet = meta.target.text;
      }
      if (!pageHash && readPage) pageHash = await readPage();
      if (!pageHash) throw Error('ページの内容を識別できません。');
      const selector: WorkspaceTarget['selector'] = {
        kind: 'pdf_page',
        pageIndex,
        expectedPageCount: resolvedPageCount,
        expectedPageContentHash: pageHash,
      };
      let contentCoords: Record<string, unknown> | undefined;
      if (location && rectPt) {
        selector.kind = isPoint ? 'pdf_pin' : 'pdf_region';
        contentCoords = { pageIndex, unit: 'pt', ...(isPoint ? { xPt: rectPt[0], yPt: rectPt[1] } : { rectPt }) };
        const digest = regionDigest ?? sha256Hex(JSON.stringify([pageHash, rectPt]));
        Object.assign(selector, isPoint ? { xPt: rectPt[0], yPt: rectPt[1] } : { rectPt }, { expectedRegionDigest: digest });
      }
      if (!isCurrent()) return;
      onTarget({
        baseRevision: artifact.revision,
        label: 'ページ ' + (pageIndex + 1) + (location ? (selector.kind === 'pdf_pin' ? ' / ピン' : ' / 矩形領域') : ''),
        selectedContentSnapshot: snippet?.slice(0, 50_000),
        selector,
        contentCoords,
      });
    } catch (e) {
      if (isCurrent()) pin.setPinError(e instanceof Error ? e.message : 'ページを選択できませんでした。');
    }
  }

  const spatialSelectionMode =
    mode === 'pin' && pin.activeMode?.primitive === 'point'
      ? 'pin'
      : mode === 'pin' && pin.activeMode?.primitive === 'rect'
        ? 'region'
        : undefined;

  return (
    <div className="workspace-page-view">
      {mode === 'pin' && pin.modes.length > 0 && (
        <PinModeToolbar
          ariaLabel="PDF の対象指定"
          selectLabel="PDF の選択方法"
          options={pin.modes}
          value={pin.activeModeId}
          onChange={pin.setModeId}
        />
      )}
      {pin.pinError && mode === 'pin' && (
        <TargetInspectionErrorBanner message={pin.pinError} onDismiss={pin.clearPinError} />
      )}
      <PdfCanvasViewer
        jumpLocation={jumpTarget?.coords}
        url={buildArtifactContentUrl(artifact)}
        filename={artifact.filename}
        documentKey={artifact.id}
        enhancedNavigation
        selectionMode={spatialSelectionMode}
        onSelectLocation={mode === 'pin' ? (location, readPage) => void capture(location.pageIndex, location.pageCount, readPage, location) : undefined}
        onSelectPage={mode === 'pin' && pin.activeMode?.primitive === 'whole' ? (index, count, readPage) => void capture(index, count, readPage) : undefined}
      />
    </div>
  );
}
