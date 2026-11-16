import React, { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  ArtifactRecord,
  AttachmentRef,
  ChatRecord,
  MessageRecord,
  ParsedSessionOptions,
  PendingPermissionRecord,
  ProjectRecord,
  RunRecord,
  ToolCallItem,
} from '../types';
import { EffortBar } from './EffortBar';
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  ShieldIcon,
  StopIcon,
} from './Icons';
import { MarkdownContent } from './MarkdownContent';

interface ChatViewProps {
  chat: ChatRecord | null;
  project: ProjectRecord | null;
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
  pendingPermissions: PendingPermissionRecord[];
  activeRun: RunRecord | null;
  sessionOptions: ParsedSessionOptions | null;
  selectedModelId: string;
  selectedEffortValue: string;
  clientId: string;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onSendPrompt: (text: string, files: AttachmentRef[]) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  onCancelRun: (runId: string) => Promise<void>;
  onSyncProject: () => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
  onPermissionUpdated: (perm: PendingPermissionRecord) => void;
}

const ThoughtsAccordion: React.FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
  const [open, setOpen] = useState(Boolean(streaming));
  if (!text.trim()) return null;

  return (
    <div className="thoughts-box">
      <button type="button" className="disclosure-btn" onClick={() => setOpen((v) => !v)}>
        <ChevronIcon size={14} dir={open ? 'down' : 'right'} />
        <span>思考プロセス {streaming ? '（生成中...）' : ''}</span>
      </button>
      {open && <pre className="thoughts-pre">{text}</pre>}
    </div>
  );
};

const ToolCallsList: React.FC<{ toolCalls: ToolCallItem[] }> = ({ toolCalls }) => {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="tools-list">
      {toolCalls.map((tc) => {
        const isOpen = Boolean(openIds[tc.toolCallId]);
        const badgeCls =
          tc.status === 'completed'
            ? 'ok'
            : tc.status === 'failed'
              ? 'danger'
              : 'pending';
        return (
          <div key={tc.toolCallId} className="tool-chip-card">
            <button
              type="button"
              className="tool-chip-head"
              onClick={() =>
                setOpenIds((prev) => ({ ...prev, [tc.toolCallId]: !prev[tc.toolCallId] }))
              }
            >
              <span className={`status-dot ${badgeCls}`} />
              <span className="tool-title truncate">{tc.title}</span>
              <span className="muted-xs">{tc.status}</span>
              <ChevronIcon size={13} dir={isOpen ? 'down' : 'right'} />
            </button>
            {isOpen && (
              <div className="tool-chip-body">
                {tc.locations && tc.locations.length > 0 && (
                  <div className="muted-xs">
                    対象: {tc.locations.map((l) => l.path).join(', ')}
                  </div>
                )}
                {tc.rawInput !== undefined && (
                  <pre className="tool-json">{JSON.stringify(tc.rawInput, null, 2)}</pre>
                )}
                {tc.rawOutput !== undefined && (
                  <pre className="tool-json">{JSON.stringify(tc.rawOutput, null, 2)}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const PermissionCard: React.FC<{
  perm: PendingPermissionRecord;
  clientId: string;
  onResolved: (perm: PendingPermissionRecord) => void;
}> = ({ perm, clientId, onResolved }) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleAction = async (optionId?: string, cancel?: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.resolvePermission(perm.chatId, perm.id, {
        optionId: optionId ?? null,
        cancel: Boolean(cancel),
        clientId,
      });
      onResolved(res.permission);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_RESOLVED') {
        const already = (err.data as { permission?: PendingPermissionRecord } | undefined)?.permission;
        if (already) {
          onResolved(already);
        }
        setNotice('別の端末または直前の操作で既に処理されました。');
      } else {
        setNotice(err instanceof ApiError ? err.message : '送信に失敗しました。');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="permission-card" role="region" aria-label="ツール実行の承認待ち">
      <div className="permission-head">
        <ShieldIcon size={16} className="warn-icon" />
        <div>
          <div className="permission-title">ツール実行の許可が求められています</div>
          <div className="muted-sm">{perm.toolCall.title}</div>
        </div>
      </div>

      {perm.toolCall.locations && perm.toolCall.locations.length > 0 && (
        <div className="permission-paths">
          {perm.toolCall.locations.map((loc, idx) => (
            <code key={idx} className="inline-code">
              {loc.path}
              {loc.line ? `:${loc.line}` : ''}
            </code>
          ))}
        </div>
      )}

      {perm.toolCall.rawInput !== undefined && (
        <pre className="tool-json">{JSON.stringify(perm.toolCall.rawInput, null, 2)}</pre>
      )}

      <div className="permission-actions">
        {perm.options.map((opt) => {
          const isReject = opt.kind.startsWith('reject');
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={busy}
              className={`btn btn-sm ${isReject ? 'btn-danger-outline' : 'btn-primary'}`}
              onClick={() => void handleAction(opt.optionId, false)}
            >
              {opt.name}
            </button>
          );
        })}
        <button
          type="button"
          disabled={busy}
          className="btn btn-ghost btn-sm"
          onClick={() => void handleAction(undefined, true)}
        >
          キャンセル
        </button>
      </div>
      {notice && <div className="muted-xs" style={{ marginTop: 6 }}>{notice}</div>}
    </div>
  );
};

export const ChatView: React.FC<ChatViewProps> = ({
  chat,
  project,
  messages,
  artifacts,
  pendingPermissions,
  activeRun,
  sessionOptions,
  selectedModelId,
  selectedEffortValue,
  clientId,
  onChangeModel,
  onChangeEffort,
  onDraftChange,
  onSendPrompt,
  onUploadFiles,
  onCancelRun,
  onSyncProject,
  onOpenArtifact,
  onPermissionUpdated,
}) => {
  const [inputText, setInputText] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [syncingProj, setSyncingProj] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const artifactsById = React.useMemo(() => {
    const map = new Map<string, ArtifactRecord>();
    for (const a of artifacts) map.set(a.id, a);
    return map;
  }, [artifacts]);

  useEffect(() => {
    setStagedAttachments([]);
    setUiNotice(null);
  }, [chat?.id]);

  useEffect(() => {
    onDraftChange?.(inputText.trim().length > 0 || stagedAttachments.length > 0);
  }, [inputText, stagedAttachments.length, onDraftChange]);

  // Smooth auto-scroll on new messages or active streaming progress
  const lastMsg = messages[messages.length - 1];
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, lastMsg?.contentText.length, pendingPermissions.length]);

  // Auto-resize composer textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText]);

  const modelOption = sessionOptions?.configOptions.find(
    (o) => o.id === sessionOptions.modelOptionId || o.category === 'model'
  );
  const effortOption = sessionOptions?.configOptions.find(
    (o) => o.id === sessionOptions.effortOptionId || o.category === 'thought_level'
  );
  const currentModelValue =
    selectedModelId || modelOption?.currentValue || modelOption?.options[0]?.value || '';
  const currentEffortValue =
    (effortOption?.options.some((o) => o.value === selectedEffortValue)
      ? selectedEffortValue
      : undefined) ||
    effortOption?.currentValue ||
    effortOption?.options[0]?.value ||
    '';
  const isRunBusy = Boolean(
    activeRun &&
      (activeRun.status === 'running' ||
        activeRun.status === 'queued' ||
        activeRun.status === 'awaiting_permission')
  );
  const configBusy = sending || uploading || isRunBusy;

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUiNotice(null);
    try {
      const uploaded = await onUploadFiles(files);
      setStagedAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setUiNotice(err instanceof ApiError ? err.message : 'ファイル添付に失敗しました。');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = inputText.trim();
    if ((!trimmed && stagedAttachments.length === 0) || sending || uploading) return;

    const toSendAttachments = stagedAttachments;
    const savedInput = inputText;
    setSending(true);
    setUiNotice(null);
    setInputText('');
    setStagedAttachments([]);

    try {
      await onSendPrompt(savedInput, toSendAttachments);
    } catch (err) {
      setInputText(savedInput);
      setStagedAttachments(toSendAttachments);
      setUiNotice(err instanceof ApiError ? err.message : 'メッセージ送信に失敗しました。');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const isMobileTouch = 'ontouchstart' in window && window.innerWidth <= 860;
    if (isMobileTouch) return;
    if (!e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void handleFilesSelected(files);
    }
  };

  const handleCopyMessage = async (msgId: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 1600);
  };

  const openAttachmentRef = async (att: AttachmentRef) => {
    const found = artifactsById.get(att.artifactId);
    if (found) {
      onOpenArtifact(found);
      return;
    }
    try {
      const res = await api.getArtifact(att.artifactId);
      onOpenArtifact(res.artifact);
    } catch {
      setUiNotice('ファイルが見つかりませんでした。');
    }
  };

  const isStaleProjectContext =
    Boolean(chat && project && project.contextVersion > chat.projectContextVersion);

  return (
    <div
      className={`chat-view ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) void handleFilesSelected(files);
      }}
    >
      {isStaleProjectContext && (
        <div className="stale-banner">
          <div className="row-actions">
            <FolderIcon size={15} />
            <span>
              プロジェクト「{project?.name}」の共有指示または資料が更新されました（現在 Ver.{chat?.projectContextVersion} → 最新 Ver.{project?.contextVersion}）。
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={syncingProj}
            onClick={async () => {
              setSyncingProj(true);
              try {
                await onSyncProject();
              } finally {
                setSyncingProj(false);
              }
            }}
          >
            <RefreshIcon size={13} className={syncingProj ? 'spin' : ''} />
            <span>{syncingProj ? '更新中...' : 'このチャットを最新化'}</span>
          </button>
        </div>
      )}

      <div className="messages-scroll">
        <div className="messages-rail">
          {messages.length === 0 ? (
            <div className="welcome-empty">
              {project ? (
                <>
                  <h2>{project.name}</h2>
                  {(project.description || project.files.length > 0) && (
                    <p className="muted-sm">
                      {project.description || `共有資料 (${project.files.length}件) が参照可能です。`}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === 'user';
              const msgPerms = pendingPermissions.filter((p) => p.runId === msg.runId && p.status === 'pending');
              const msgArtifacts = (msg.artifactIds ?? [])
                .map((id) => artifactsById.get(id))
                .filter((a): a is ArtifactRecord => Boolean(a));

              if (isUser) {
                return (
                  <div key={msg.id} className="msg-row user">
                    <div className="user-bubble">
                      {msg.attachments.length > 0 && (
                        <div className="att-chip-row">
                          {msg.attachments.map((att) => (
                            <button
                              key={att.artifactId}
                              type="button"
                              className="att-chip"
                              onClick={() => void openAttachmentRef(att)}
                            >
                              <FileIcon size={13} />
                              <span>{att.filename}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {msg.contentText && <div className="user-text">{msg.contentText}</div>}
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} className="msg-row assistant">
                  <div className="assistant-body">
                    {msg.status === 'queued' && (
                      <div className="queue-status-pill">
                        待機中
                        {activeRun?.id === msg.runId && activeRun.queuePosition > 0
                          ? `（順番 #${activeRun.queuePosition}）`
                          : '...'}
                      </div>
                    )}

                    <ThoughtsAccordion
                      text={msg.thoughtsText}
                      streaming={msg.status === 'streaming' && !msg.contentText}
                    />

                    <ToolCallsList toolCalls={msg.toolCalls} />

                    {msgPerms.map((perm) => (
                      <PermissionCard
                        key={perm.id}
                        perm={perm}
                        clientId={clientId}
                        onResolved={onPermissionUpdated}
                      />
                    ))}

                    {msg.contentText ? (
                      <div className="assistant-markdown">
                        <MarkdownContent
                          content={msg.contentText}
                          chatId={chat?.id}
                          onOpenArtifact={onOpenArtifact}
                          onResolveError={(m) => setUiNotice(m)}
                        />
                        {msg.status === 'streaming' && <span className="stream-cursor" />}
                      </div>
                    ) : msg.status === 'streaming' ? (
                      <div className="streaming-placeholder">
                        <span className="pulse-dot" /> 応答を生成中...
                      </div>
                    ) : msg.status === 'cancelled' ? (
                      <div className="muted-sm">（生成がキャンセルされました）</div>
                    ) : null}

                    {msg.errorMessage && <div className="error-box">{msg.errorMessage}</div>}

                    {msgArtifacts.length > 0 && (
                      <div className="artifacts-bar">
                        {msgArtifacts.map((art) => (
                          <button
                            key={art.id}
                            type="button"
                            className="artifact-pill"
                            onClick={() => onOpenArtifact(art)}
                          >
                            <FileIcon size={14} />
                            <span>{art.filename}</span>
                            {art.diffPatch && <span className="diff-tag">Diff</span>}
                          </button>
                        ))}
                      </div>
                    )}

                    {msg.status !== 'streaming' && msg.status !== 'queued' && msg.contentText && (
                      <div className="msg-actions">
                        <button
                          type="button"
                          className="chip-btn"
                          onClick={() => void handleCopyMessage(msg.id, msg.contentText)}
                        >
                          {copiedMsgId === msg.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                          <span>{copiedMsgId === msg.id ? 'コピー済' : '回答をコピー'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="composer-dock">
        <div className="composer-inner">
          {uiNotice && (
            <div className="composer-notice">
              <span>{uiNotice}</span>
              <button type="button" className="icon-btn-sm" onClick={() => setUiNotice(null)}>
                <CloseIcon size={14} />
              </button>
            </div>
          )}

          {stagedAttachments.length > 0 && (
            <div className="att-chip-row staged">
              {stagedAttachments.map((att) => (
                <div key={att.artifactId} className="att-chip staged-item">
                  <FileIcon size={13} />
                  <span>{att.filename}</span>
                  <button
                    type="button"
                    className="icon-btn-sm"
                    onClick={() =>
                      setStagedAttachments((prev) =>
                        prev.filter((a) => a.artifactId !== att.artifactId)
                      )
                    }
                    aria-label="添付を除外"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="composer-box">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = '';
                void handleFilesSelected(list);
              }}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={uploading ? 'ファイルをアップロード中...' : 'Antigravity に聞く'}
              disabled={uploading}
            />

            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                <button
                  type="button"
                  className="composer-icon-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="ファイルを添付（複数・画像ペースト・ドロップ対応）"
                  aria-label="ファイルを添付"
                >
                  <PlusIcon size={19} />
                </button>

                {modelOption && modelOption.options.length > 0 && (
                  <select
                    aria-label="モデル選択"
                    className="composer-model-select"
                    value={currentModelValue}
                    disabled={configBusy}
                    onChange={(e) => onChangeModel(e.target.value)}
                    title="使用モデルを選択"
                  >
                    {modelOption.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="composer-toolbar-right">
                {effortOption && effortOption.options.length > 0 && (
                  <EffortBar
                    options={effortOption.options}
                    value={currentEffortValue}
                    disabled={configBusy}
                    onChange={onChangeEffort}
                  />
                )}

                {isRunBusy && activeRun && (
                  <button
                    type="button"
                    className="stop-btn"
                    onClick={() => void onCancelRun(activeRun.id)}
                    title="生成・キューを停止"
                  >
                    <StopIcon size={14} />
                  </button>
                )}

                <button
                  type="submit"
                  className="send-btn"
                  disabled={sending || uploading || (!inputText.trim() && stagedAttachments.length === 0)}
                  title="送信"
                >
                  <SendIcon size={17} />
                </button>
              </div>
            </div>
          </form>

          <div className="composer-hint">
            <span>Enter で送信 / Shift+Enter で改行・別端末ともリアルタイム同期</span>
          </div>
        </div>
      </div>
    </div>
  );
};
