import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ArtifactRecord, WorkspaceFileEntry } from '../types';
import { CloseIcon, FileIcon, FolderIcon, RefreshIcon } from './Icons';

interface WorkspaceDrawerProps {
  chatId: string;
  artifacts: ArtifactRecord[];
  onClose: () => void;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
}

export const WorkspaceDrawer: React.FC<WorkspaceDrawerProps> = ({
  chatId,
  artifacts,
  onClose,
  onOpenArtifact,
}) => {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getWorkspace(chatId);
      setFiles(res.files);
    } catch {
      setError('作業ディレクトリの読込に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFiles();
  }, [chatId, artifacts.length]);

  const handleOpenRelPath = async (relPath: string) => {
    const known = artifacts.find((a) => a.relPath === relPath);
    if (known) {
      onOpenArtifact(known);
      return;
    }
    try {
      const resolved = await api.resolveLink(chatId, relPath);
      onOpenArtifact(resolved.artifact);
    } catch {
      setError(`ファイル ${relPath} を開けませんでした`);
    }
  };

  const workFiles = files.filter((f) => !f.isProjectContext);
  const contextFiles = files.filter((f) => f.isProjectContext);

  return (
    <aside className="workspace-drawer" aria-label="チャット作業ファイル">
      <div className="drawer-head">
        <div>
          <div className="popover-title">作業ファイル</div>
          <div className="muted-xs">このチャット専用の作業領域</div>
        </div>
        <div className="row-actions">
          <button type="button" className="icon-btn-sm" onClick={() => void loadFiles()} title="再読込">
            <RefreshIcon size={14} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" className="icon-btn-sm" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      <div className="drawer-body">
        {error && <div className="error-box">{error}</div>}
        {loading && files.length === 0 ? (
          <div className="muted-sm" style={{ padding: 12 }}>読込中...</div>
        ) : files.length === 0 ? (
          <div className="muted-sm" style={{ padding: 12 }}>
            添付ファイルやAIが生成したファイルがここに表示されます。
          </div>
        ) : (
          <>
            {workFiles.length > 0 && (
              <div className="drawer-group">
                <div className="drawer-group-title">生成・添付ファイル ({workFiles.length})</div>
                {workFiles.map((f) => (
                  <button
                    key={f.relPath}
                    type="button"
                    className="drawer-file-item"
                    onClick={() => void handleOpenRelPath(f.relPath)}
                  >
                    <FileIcon size={15} />
                    <div className="drawer-file-meta">
                      <div className="drawer-file-name">{f.name}</div>
                      <div className="muted-xs">{f.relPath}</div>
                    </div>
                    <span className="muted-xs">{Math.max(1, Math.round(f.sizeBytes / 1024))}KB</span>
                  </button>
                ))}
              </div>
            )}

            {contextFiles.length > 0 && (
              <div className="drawer-group">
                <div className="drawer-group-title">
                  <FolderIcon size={13} /> プロジェクト参照コピー ({contextFiles.length})
                </div>
                {contextFiles.map((f) => (
                  <button
                    key={f.relPath}
                    type="button"
                    className="drawer-file-item"
                    onClick={() => void handleOpenRelPath(f.relPath)}
                  >
                    <FileIcon size={15} />
                    <div className="drawer-file-meta">
                      <div className="drawer-file-name">{f.name}</div>
                      <div className="muted-xs">{f.relPath}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
};
