import { ModalDialog } from './ModalDialog';
import React, { useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { ProjectRecord } from '../types';
import { CloseIcon, DownloadIcon, FileIcon, PlusIcon, TrashIcon } from './Icons';
import { McpModal } from './McpModal';
import { SkillsModal } from './SkillsModal';

type ProjectSettingsTab = 'general' | 'files' | 'skills' | 'mcp';

interface ProjectModalProps {
  project: ProjectRecord | null; // null = create mode
  projects: ProjectRecord[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (project: ProjectRecord) => void;
  onDeleted?: (projectId: string) => void;
  onStartChatInProject?: (projectId: string) => void;
  onSkillsChanged?: () => void;
}

export const ProjectModal: React.FC<ProjectModalProps> = ({
  project,
  projects,
  isAdmin,
  onClose,
  onSaved,
  onDeleted,
  onStartChatInProject,
  onSkillsChanged,
}) => {
  const [currentProject, setCurrentProject] = useState<ProjectRecord | null>(project);
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>('general');
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canClose = () => {
    if (busy) return false;
    const dirty =
      name.trim() !== (currentProject?.name ?? '') ||
      description.trim() !== (currentProject?.description ?? '') ||
      instructions !== (currentProject?.instructions ?? '');
    return !dirty || window.confirm('保存していない変更を破棄しますか？');
  };
  const requestClose = () => {
    if (canClose()) onClose();
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      if (!currentProject) {
        const res = await api.createProject({
          name: name.trim(),
          description: description.trim(),
          instructions,
        });
        onSaved(res.project);
        onStartChatInProject?.(res.project.id);
        onClose();
        return;
      } else {
        const res = await api.updateProject(currentProject.id, {
          name: name.trim(),
          description: description.trim(),
          instructions,
        });
        setCurrentProject(res.project);
        onSaved(res.project);
        setStatusNote('保存しました。既存のプロジェクト内チャットには「最新化」通知が表示されます。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!currentProject || fileList.length === 0) return;

    const existingNames = new Set(currentProject.files.map((f) => f.filename));
    const duplicates = Array.from(
      new Set(fileList.map((f) => f.name).filter((fname) => existingNames.has(fname)))
    );
    if (duplicates.length > 0) {
      const preview =
        duplicates.length <= 3
          ? duplicates.join('、')
          : `${duplicates.slice(0, 3).join('、')} ほか${duplicates.length - 3}件`;
      if (!window.confirm(`同名の共有資料（${preview}）が既にあります。上書きしますか？`)) {
        return;
      }
    }

    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.uploadProjectFiles(currentProject.id, fileList);
      setCurrentProject(res.project);
      onSaved(res.project);
      const overwrittenCount = res.uploaded.filter((u) => existingNames.has(u.filename)).length;
      const addedCount = res.uploaded.length - overwrittenCount;
      if (overwrittenCount > 0 && addedCount > 0) {
        setStatusNote(`${addedCount}件の資料を追加し、${overwrittenCount}件を上書きしました。`);
      } else if (overwrittenCount > 0) {
        setStatusNote(`${overwrittenCount}件の資料を上書きしました。`);
      } else {
        setStatusNote(`${res.uploaded.length}件の資料を追加しました。`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'アップロードに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteFile = async (fileId: string, filename: string) => {
    if (!currentProject || !window.confirm(`共有資料「${filename}」を削除しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteProjectFile(currentProject.id, fileId);
      setCurrentProject(res.project);
      onSaved(res.project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!currentProject) return;
    if (
      !window.confirm(
        `プロジェクト "${currentProject.name}" を削除しますか？（所属チャット自体は通常のチャットとして残ります）`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteProject(currentProject.id);
      onDeleted?.(currentProject.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: ProjectSettingsTab; label: string; count?: number }> = [
    { id: 'general', label: '基本設定' },
    { id: 'files', label: '資料', count: currentProject?.files.length ?? 0 },
    { id: 'skills', label: 'スキル' },
    ...(isAdmin ? [{ id: 'mcp' as const, label: 'MCP' }] : []),
  ];

  const isEmbeddedTab = Boolean(currentProject && (activeTab === 'skills' || activeTab === 'mcp'));

  return (
    <ModalDialog
      label={currentProject ? 'プロジェクト設定' : '新しいプロジェクト'}
      size={currentProject ? 'modal-xl project-settings-modal' : 'modal-lg'}
      onClose={requestClose}
    >
      <div className="modal-head project-modal-head">
        <div className="modal-head-title-wrap">
          <h3
            className="truncate"
            title={currentProject ? `プロジェクト設定: ${currentProject.name}` : '新しいプロジェクト'}
          >
            {currentProject ? `プロジェクト設定: ${currentProject.name}` : '新しいプロジェクト'}
          </h3>
          {currentProject && (
            <span className="muted-xs">コンテキスト Ver.{currentProject.contextVersion}</span>
          )}
        </div>
        <div className="row-actions modal-head-actions">
          {currentProject && onStartChatInProject && (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => {
                if (!canClose()) return;
                onStartChatInProject(currentProject.id);
                onClose();
              }}
            >
              <PlusIcon size={14} /> 新規チャット
            </button>
          )}
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        </div>
      </div>

      {currentProject && (
        <div className="skills-scope-tabs project-settings-tabs" role="tablist" aria-label="プロジェクト設定タブ">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`skills-scope-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                setError(null);
                setStatusNote(null);
              }}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && <span className="skills-tab-count">{tab.count}</span>}
            </button>
          ))}
        </div>
      )}

      {isEmbeddedTab && currentProject ? (
        <div className="project-embedded-tab-body">
          {activeTab === 'skills' && (
            <SkillsModal
              embedded
              lockedScope="project"
              activeChatId={null}
              activeProjectId={currentProject.id}
              projects={projects}
              onSkillsChanged={onSkillsChanged}
            />
          )}
          {activeTab === 'mcp' && isAdmin && (
            <McpModal embedded mode="project" projectId={currentProject.id} />
          )}
        </div>
      ) : (
        <div className="modal-body stack-gap">
          {(!currentProject || activeTab === 'general') && (
            <form onSubmit={handleSave} className="stack-gap">
              <label className="field">
                <span>プロジェクト名</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例: Webアプリ開発 / 資格試験対策"
                  required
                />
              </label>

              <label className="field">
                <span>説明（任意）</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="目的や対象リポジトリなどのメモ"
                />
              </label>

              <label className="field">
                <span>共有カスタム指示（System Instructions）</span>
                <textarea
                  rows={5}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="このプロジェクト内のすべてのチャットで適用したいルール、役割、回答方針などを記述してください。"
                />
              </label>

              <div className="row-between">
                <div>
                  {currentProject && (
                    <button
                      type="button"
                      className="btn btn-danger-outline btn-sm"
                      onClick={handleDeleteProject}
                      disabled={busy}
                    >
                      <TrashIcon size={14} /> プロジェクト削除
                    </button>
                  )}
                </div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
                  {busy ? '保存中...' : currentProject ? '変更を保存' : 'プロジェクトを作成'}
                </button>
              </div>
            </form>
          )}

          {currentProject && activeTab === 'files' && (
            <section className="settings-section">
              <div className="row-between" style={{ marginBottom: 10 }}>
                <div className="min-w-0">
                  <h4>共有資料</h4>
                  <p className="muted-xs">このプロジェクトのチャットで参照できます。</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  <PlusIcon size={14} /> 資料を追加
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={handleUploadFiles}
                />
              </div>

              {currentProject.files.length === 0 ? (
                <div className="empty-box muted-sm">共有資料はまだありません</div>
              ) : (
                <div className="project-files-list">
                  {currentProject.files.map((f) => (
                    <div key={f.id} className="project-file-row">
                      <div className="project-file-main">
                        <FileIcon size={15} />
                        <span className="truncate" title={f.filename}>
                          {f.filename}
                        </span>
                        <span className="muted-xs project-file-size">
                          ({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)
                        </span>
                      </div>
                      <div className="row-actions project-file-actions">
                        <a
                          href={`/api/projects/${currentProject.id}/files/${f.id}/content`}
                          className="icon-btn-sm"
                          title="ダウンロード"
                          aria-label={`「${f.filename}」をダウンロード`}
                          download={f.filename}
                        >
                          <DownloadIcon size={14} />
                        </a>
                        <button
                          type="button"
                          className="icon-btn-sm danger"
                          onClick={() => handleDeleteFile(f.id, f.filename)}
                          disabled={busy}
                          aria-label={`「${f.filename}」を削除`}
                          title="削除"
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {statusNote && (
            <div className="success-box" role="status">
              {statusNote}
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </ModalDialog>
  );
};
