import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRecord, WorkspaceFileEntry } from '../types';
import {
  buildWorkspaceTree,
  findKnownArtifact,
  formatBytesCompact,
  getCachedWorkspace,
  getWorkspaceFolderExpandedMap,
  loadWorkspaceCached,
  previewKindLabel,
  resolveLinkCached,
  setWorkspaceFolderExpanded,
  type WorkspaceTreeNode,
} from '../utils/viewerCache';
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon, RefreshIcon, SearchIcon } from './Icons';

interface WorkspaceDrawerProps {
  chatId: string;
  artifacts: ArtifactRecord[];
  workspaceSyncToken?: number;
  onClose: () => void;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
}

const WorkspaceTreeBranch: React.FC<{
  nodes: WorkspaceTreeNode[];
  depth: number;
  expandedMap: Record<string, boolean>;
  forceExpandAll: boolean;
  onToggleFolder: (folderPath: string) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
}> = React.memo(({ nodes, depth, expandedMap, forceExpandAll, onToggleFolder, onOpenFile }) => {
  return (
    <>
      {nodes.map((node) => {
        const indentStyle = depth > 0 ? { paddingLeft: 8 + Math.min(depth, 5) * 14 } : undefined;
        if (node.kind === 'folder') {
          const isExpanded = forceExpandAll ? true : (expandedMap[node.path] ?? true);
          return (
            <div key={`dir:${node.path}`} className="drawer-tree-folder">
              <button
                type="button"
                className="drawer-folder-btn"
                style={indentStyle}
                onClick={() => onToggleFolder(node.path)}
                aria-expanded={isExpanded}
                title={node.path}
              >
                <ChevronIcon size={12} dir={isExpanded ? 'down' : 'right'} />
                <FolderIcon size={14} />
                <span className="drawer-folder-name truncate">{node.name}</span>
                <span className="muted-xs">{node.fileCount}</span>
              </button>
              {isExpanded && (
                <div className="drawer-tree-children">
                  <WorkspaceTreeBranch
                    nodes={node.children}
                    depth={depth + 1}
                    expandedMap={expandedMap}
                    forceExpandAll={forceExpandAll}
                    onToggleFolder={onToggleFolder}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
            </div>
          );
        }

        const f = node.entry;
        return (
          <button
            key={`file:${f.relPath}`}
            type="button"
            className="drawer-file-item"
            style={indentStyle}
            onClick={() => onOpenFile(f)}
            title={f.relPath}
          >
            <FileIcon size={14} />
            <div className="drawer-file-meta">
              <div className="drawer-file-name">{f.name}</div>
            </div>
            <div className="drawer-file-right">
              <span className="drawer-kind-pill">{previewKindLabel(f.previewKind)}</span>
              <span className="muted-xs drawer-file-size">{formatBytesCompact(f.sizeBytes)}</span>
            </div>
          </button>
        );
      })}
    </>
  );
});

export const WorkspaceDrawer: React.FC<WorkspaceDrawerProps> = React.memo(({
  chatId,
  artifacts,
  workspaceSyncToken = 0,
  onClose,
  onOpenArtifact,
}) => {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>(() => getCachedWorkspace(chatId)?.files ?? []);
  const [loading, setLoading] = useState(() => !getCachedWorkspace(chatId));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(() =>
    getWorkspaceFolderExpandedMap(chatId)
  );

  const deferredFilter = useDeferredValue(filterText.trim().toLowerCase());
  const activeChatRef = useRef(chatId);
  activeChatRef.current = chatId;
  const prevSyncRef = useRef<{ chatId: string; token: number }>({
    chatId,
    token: workspaceSyncToken,
  });

  const fetchWorkspace = useCallback(async (targetChatId: string, opts: { force?: boolean; explicit?: boolean } = {}) => {
    const hasCached = Boolean(getCachedWorkspace(targetChatId));
    if (opts.explicit) {
      setRefreshing(true);
    } else if (!hasCached) {
      setLoading(true);
    }
    setError(null);
    try {
      const entry = await loadWorkspaceCached(targetChatId, { force: opts.force });
      if (activeChatRef.current === targetChatId) {
        setFiles(entry.files);
      }
    } catch {
      if (activeChatRef.current === targetChatId) {
        setError('作業ディレクトリの読込に失敗しました。');
      }
    } finally {
      if (activeChatRef.current === targetChatId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const cached = getCachedWorkspace(chatId);
    const prev = prevSyncRef.current;
    const chatChanged = prev.chatId !== chatId;
    const tokenChanged = !chatChanged && prev.token !== workspaceSyncToken;
    prevSyncRef.current = { chatId, token: workspaceSyncToken };

    if (chatChanged) {
      setFiles(cached?.files ?? []);
      setLoading(!cached);
      setRefreshing(false);
      setError(null);
      setFilterText('');
      setExpandedMap(getWorkspaceFolderExpandedMap(chatId));
    } else if (cached) {
      setFiles(cached.files);
      setLoading(false);
    }

    if (!cached || cached.dirty || tokenChanged) {
      void fetchWorkspace(chatId, { force: Boolean(cached?.dirty || tokenChanged) });
    }
  }, [chatId, workspaceSyncToken, fetchWorkspace]);

  const handleToggleFolder = useCallback(
    (folderPath: string) => {
      setExpandedMap((prev) => {
        const current = prev[folderPath] ?? true;
        const next = !current;
        setWorkspaceFolderExpanded(chatId, folderPath, next);
        return { ...prev, [folderPath]: next };
      });
    },
    [chatId]
  );

  const handleOpenFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      setError(null);
      const known =
        artifacts.find((a) => a.relPath === entry.relPath) ??
        findKnownArtifact(chatId, entry.relPath);
      if (
        known &&
        known.sizeBytes === entry.sizeBytes &&
        Math.floor(entry.mtimeMs) <= known.updatedAt
      ) {
        onOpenArtifact(known);
        return;
      }
      void resolveLinkCached(chatId, entry.relPath, {
        forceRefresh: Boolean(known),
      })
        .then((resolved) => {
          onOpenArtifact(resolved.artifact);
        })
        .catch(() => {
          setError(`ファイル ${entry.relPath} を開けませんでした`);
        });
    },
    [artifacts, chatId, onOpenArtifact]
  );

  const filteredFiles = useMemo(() => {
    if (!deferredFilter) return files;
    return files.filter(
      (f) =>
        f.name.toLowerCase().includes(deferredFilter) ||
        f.relPath.toLowerCase().includes(deferredFilter)
    );
  }, [files, deferredFilter]);

  const workFiles = useMemo(() => filteredFiles.filter((f) => !f.isProjectContext), [filteredFiles]);
  const contextFiles = useMemo(() => filteredFiles.filter((f) => f.isProjectContext), [filteredFiles]);

  const workTree = useMemo(() => buildWorkspaceTree(workFiles), [workFiles]);
  const contextTree = useMemo(() => buildWorkspaceTree(contextFiles), [contextFiles]);

  const isFiltering = deferredFilter.length > 0;

  return (
    <aside className="workspace-drawer" aria-label="チャット作業ファイル">
      <div className="drawer-head">
        <div>
          <div className="popover-title">作業ファイル</div>
          <div className="muted-xs">このチャット専用の作業領域</div>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="icon-btn-sm"
            onClick={() => void fetchWorkspace(chatId, { force: true, explicit: true })}
            title="再読込"
            aria-label="作業ファイルを再読込"
          >
            <RefreshIcon size={14} className={loading || refreshing ? 'spin' : ''} />
          </button>
          <button type="button" className="icon-btn-sm" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      {files.length >= 6 && (
        <div className="drawer-search-row">
          <SearchIcon size={13} />
          <input
            type="search"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="ファイルを絞り込み..."
            aria-label="作業ファイルを絞り込み"
          />
          {filterText && (
            <button
              type="button"
              className="icon-btn-sm"
              onClick={() => setFilterText('')}
              aria-label="検索をクリア"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      )}

      <div className="drawer-body">
        {error && <div className="error-box">{error}</div>}
        {loading && files.length === 0 ? (
          <div className="muted-sm" style={{ padding: 12 }}>読込中...</div>
        ) : files.length === 0 ? (
          <div className="muted-sm" style={{ padding: 12 }}>
            添付ファイルやAIが生成したファイルがここに表示されます。
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="muted-sm" style={{ padding: 12 }}>
            一致するファイルはありません。
          </div>
        ) : (
          <>
            {workFiles.length > 0 && (
              <div className="drawer-group">
                <div className="drawer-group-title">生成・添付ファイル ({workFiles.length})</div>
                <WorkspaceTreeBranch
                  nodes={workTree}
                  depth={0}
                  expandedMap={expandedMap}
                  forceExpandAll={isFiltering}
                  onToggleFolder={handleToggleFolder}
                  onOpenFile={handleOpenFile}
                />
              </div>
            )}

            {contextFiles.length > 0 && (
              <div className="drawer-group">
                <div className="drawer-group-title">
                  <FolderIcon size={13} /> プロジェクト参照コピー ({contextFiles.length})
                </div>
                <WorkspaceTreeBranch
                  nodes={contextTree}
                  depth={0}
                  expandedMap={expandedMap}
                  forceExpandAll={isFiltering}
                  onToggleFolder={handleToggleFolder}
                  onOpenFile={handleOpenFile}
                />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
});
