import React, { useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { ProjectRecord } from '../types';
import { CloseIcon, DownloadIcon, FileIcon, PlusIcon, TrashIcon } from './Icons';

interface ProjectModalProps {
  project: ProjectRecord | null; // null = create mode
  onClose: () => void;
  onSaved: (project: ProjectRecord) => void;
  onDeleted?: (projectId: string) => void;
  onStartChatInProject?: (projectId: string) => void;
}

export const ProjectModal: React.FC<ProjectModalProps> = ({
  project,
  onClose,
  onSaved,
  onDeleted,
  onStartChatInProject,
}) => {
  const [currentProject, setCurrentProject] = useState<ProjectRecord | null>(project);
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        setCurrentProject(res.project);
        onSaved(res.project);
        setStatusNote('プロジェクトを作成しました。必要に応じて参考資料を追加できます。');
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

    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadProjectFiles(currentProject.id, fileList);
      setCurrentProject(res.project);
      onSaved(res.project);
      setStatusNote(`${res.uploaded.length}件の資料を追加しました。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'アップロードに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!currentProject) return;
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
    if (!window.confirm(`プロジェクト "${currentProject.name}" を削除しますか？（所属チャット自体は通常のチャットとして残ります）`)) {
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{currentProject ? `プロジェクト設定: ${currentProject.name}` : '新しいプロジェクト'}</h3>
            {currentProject && (
              <span className="muted-xs">コンテキスト Ver.{currentProject.contextVersion}</span>
            )}
          </div>
          <div className="row-actions">
            {currentProject && onStartChatInProject && (
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={() => {
                  onStartChatInProject(currentProject.id);
                  onClose();
                }}
              >
                <PlusIcon size={14} /> この中でチャット開始
              </button>
            )}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
              <CloseIcon size={18} />
            </button>
          </div>
        </div>

        <div className="modal-body stack-gap">
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
              <span>概要メモ（任意）</span>
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
                rows={4}
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

          {currentProject && (
            <section className="settings-section">
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div>
                  <h4>共有ナレッジ資料 (.project-context/)</h4>
                  <p className="muted-xs">
                    各チャットの作業領域へコピーオンライトで読み込まれる参照資料です（会話中に原紙が破壊されることはありません）。
                  </p>
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
                      <div className="row-actions">
                        <FileIcon size={15} />
                        <span>{f.filename}</span>
                        <span className="muted-xs">({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)</span>
                      </div>
                      <div className="row-actions">
                        <a
                          href={`/api/projects/${currentProject.id}/files/${f.id}/content`}
                          className="icon-btn-sm"
                          title="ダウンロード"
                          download={f.filename}
                        >
                          <DownloadIcon size={14} />
                        </a>
                        <button
                          type="button"
                          className="icon-btn-sm danger"
                          onClick={() => handleDeleteFile(f.id)}
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

          {statusNote && <div className="success-box">{statusNote}</div>}
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    </div>
  );
};
