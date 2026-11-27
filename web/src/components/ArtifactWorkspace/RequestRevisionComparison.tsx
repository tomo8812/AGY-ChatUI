import React, { useEffect, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { workspaceApi, type EditRequestRecord, type WorkspaceRevision } from '../../api/workspace';
import type { ArtifactRecord } from '../../types';
import { buildArtifactContentUrl } from '../../utils/viewerCache';
import { ArtifactViewerModal, DiffPatchView } from '../ArtifactViewerModal';
import { ModalDialog } from '../ModalDialog';

function atRevision(artifact: ArtifactRecord, version: WorkspaceRevision): ArtifactRecord {
  const { revision, sha256, sizeBytes, dependencyManifestHash } = version;
  return { ...artifact, revision, sha256, sizeBytes, dependencyManifestHash, diffPatch: null };
}

const maxDiffBytes = 256 * 1024;

export function RequestRevisionComparison({ artifact, request, onClose }: {
  artifact: ArtifactRecord;
  request: EditRequestRecord;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<WorkspaceRevision[]>();
  const [preview, setPreview] = useState<ArtifactRecord>();
  const [patch, setPatch] = useState<string>();
  const [error, setError] = useState('');
  const text = artifact.previewKind === 'markdown' || artifact.previewKind === 'code' || /\.(csv|tsv)$/i.test(artifact.filename);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const { revisions } = await workspaceApi.history(artifact.id, controller.signal);
      const pair = [request.baseRevision, request.appliedRevision].flatMap(revision => {
        const version = revisions.find(candidate => candidate.revision === revision);
        return version ? [version] : [];
      });
      if (controller.signal.aborted) return;
      setVersions(pair);
      if (!text || pair.length !== 2 || pair.some(version => !version.previewable || version.sizeBytes > maxDiffBytes)) return;
      const [before, after] = await Promise.all(pair.map(async version => {
        const response = await fetch(buildArtifactContentUrl(atRevision(artifact, version)), {
          signal: controller.signal, credentials: 'include',
        });
        if (!response.ok || response.headers.get('X-Artifact-Revision') !== String(version.revision) ||
          response.headers.get('X-Artifact-Sha256') !== version.sha256) throw Error('比較用のバージョンを取得できませんでした。');
        return response.text();
      }));
      const diff = createTwoFilesPatch('v' + request.baseRevision, 'v' + request.appliedRevision, before, after,
        undefined, undefined, { timeout: 200, maxEditLength: 8000 });
      if (!controller.signal.aborted && diff) setPatch(diff);
    };
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'バージョンを取得できませんでした。');
    });
    return () => controller.abort();
  }, [artifact.id, request.baseRevision, request.appliedRevision, text]);

  return <>
    <ModalDialog label="変更前後のバージョン" size="workspace-request-version" onClose={onClose}>
      <div>
        <h3>変更前後のバージョン</h3>
        {error && <p role="alert">{error}</p>}
        {!versions && !error && <p role="status">読み込み中…</p>}
        {versions && <div className="row-actions">
          {[request.baseRevision, request.appliedRevision].map((number, index) => {
            const version = versions.find(candidate => candidate.revision === number);
            return <button key={index} type="button" className="btn btn-secondary btn-sm"
              disabled={!version?.previewable} onClick={() => version && setPreview(atRevision(artifact, version))}>
              {index === 0 ? '依頼時' : '適用時'} v{number}
            </button>;
          })}
          {versions.filter(version => version.previewable).length < 2 && <p>履歴の一部を表示できません。</p>}
        </div>}
        {patch && <DiffPatchView versionKey={artifact.id + ':' + request.baseRevision + ':' + request.appliedRevision} patch={patch}/>}
      </div>
    </ModalDialog>
    {preview && <ArtifactViewerModal artifact={preview} projects={[]} onClose={() => setPreview(undefined)}/>}
  </>;
}
