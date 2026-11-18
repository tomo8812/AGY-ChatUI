import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  ArtifactRecord,
  AttachmentRef,
  AvailableCommandItem,
  ChatRecord,
  MessageRecord,
  ParsedSessionOptions,
  PendingPermissionRecord,
  ProjectRecord,
  RunRecord,
  ToolCallItem,
} from '../types';
import { getMessageActivity } from '../utils/messageActivity';
import { isAppleTouchHapticsFallback, triggerHaptic } from '../utils/haptics';
import { EffortBar } from './EffortBar';
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ComposeIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SlashIcon,
  SparklesIcon,
  StopIcon,
  TerminalIcon,
} from './Icons';
import { FileReferenceLink, MarkdownContent, type FileLinkProps } from './MarkdownContent';

interface ChatViewProps {
  chat: ChatRecord | null;
  project: ProjectRecord | null;
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
  pendingPermissions: PendingPermissionRecord[];
  activeRun: RunRecord | null;
  sessionOptions: ParsedSessionOptions | null;
  availableCommands?: AvailableCommandItem[];
  selectedModelId: string;
  selectedEffortValue: string;
  draftResetToken?: number;
  clientId: string;
  hapticEnabled?: boolean;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onSendPrompt: (text: string, files: AttachmentRef[]) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  onCancelRun: (runId: string) => Promise<void>;
  onSyncProject: () => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
  onPermissionUpdated: (perm: PendingPermissionRecord) => void;
  onOpenSkills?: () => void;
  externalDraftCommand?: { slug: string; token: number } | null;
}

const EMPTY_PERMS: PendingPermissionRecord[] = [];
const EMPTY_ARTIFACTS: ArtifactRecord[] = [];
const EMPTY_SELECT_OPTIONS: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'] = [];

function toolIsActive(tool: ToolCallItem): boolean {
  return tool.status === 'pending' || tool.status === 'in_progress' ||
    tool.subagentState === 'running' || tool.subagentState === 'requires_action';
}

function toolIcon(kind: ToolCallItem['kind']) {
  switch (kind) {
    case 'execute': return TerminalIcon;
    case 'edit': return ComposeIcon;
    case 'read': return FileIcon;
    case 'search': return SearchIcon;
    default: return SparklesIcon;
  }
}

function toolSummary(tools: ToolCallItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    let label: string;
    switch (tool.kind) {
      case 'edit': label = 'ファイル編集'; break;
      case 'execute': label = 'コマンド'; break;
      case 'read': label = '読み取り'; break;
      case 'search': label = '検索'; break;
      default: label = 'ツール実行';
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}件`).join(' · ');
}

const ToolActivity: React.FC<FileLinkProps & { tools: ToolCallItem[] }> = ({ tools, ...fileLinks }) => {
  const active = tools.findLast(toolIsActive);
  const Icon = toolIcon(tools[0].kind);

  return (
    <details className="activity-tools">
      <summary className="activity-summary">
        {active ? <span className="owui-tool-spinner" aria-hidden="true" /> : <Icon size={15} />}
        <span className="truncate" title={active?.title}>
          {active ? `実行中 · ${active.subagentLabel || active.title}` : toolSummary(tools)}
        </span>
        <ChevronIcon size={13} dir="right" className="activity-chevron" />
      </summary>
      <ToolCallsList toolCalls={tools} {...fileLinks} />
    </details>
  );
};

function isSubagentTool(tc: ToolCallItem): boolean {
  if (tc.isSubagent) return true;
  return /subagent|invoke_subagent|define_subagent|manage_subagents|generate_image|image_gen|画像生成|サブエージェント/i.test(
    `${tc.name ?? ''} ${tc.title ?? ''}`
  );
}

function toolOutputStatus(tool: ToolCallItem): MessageRecord['status'] {
  return toolIsActive(tool) ? 'streaming' : 'completed';
}

const ToolLocations: React.FC<FileLinkProps & { locations: ToolCallItem['locations'] }> = ({ locations, ...fileLinks }) => {
  if (!locations?.length) return null;
  return (
    <div className="muted-xs">
      対象: {locations.map((location, index) => (
        <React.Fragment key={index}>
          {index > 0 && ', '}
          <FileReferenceLink reference={location.path} {...fileLinks} />
        </React.Fragment>
      ))}
    </div>
  );
};

const ToolCallsList: React.FC<FileLinkProps & { toolCalls: ToolCallItem[] }> = React.memo(({ toolCalls, ...fileLinks }) => {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="owui-tools-list">
      {toolCalls.map((tc) => {
        const isOpen = Boolean(openIds[tc.toolCallId]);
        const subagent = isSubagentTool(tc);
        const messageStatus = toolOutputStatus(tc);
        const isRunning = messageStatus === 'streaming';
        const Icon = toolIcon(tc.kind);
        const isFailed = tc.status === 'failed';
        const displayTitle = tc.subagentLabel || tc.title;
        const hasDetails =
          Boolean(tc.locations && tc.locations.length > 0) ||
          Boolean(tc.contentText) ||
          Boolean(tc.subagentThoughtsText) ||
          Boolean(tc.subagentContentText) ||
          Boolean(tc.subagentToolCalls && tc.subagentToolCalls.length > 0) ||
          tc.rawInput !== undefined ||
          tc.rawOutput !== undefined;

        return (
          <div
            key={tc.toolCallId}
            className={`owui-tool-item ${isRunning ? 'is-running' : ''} ${isFailed ? 'is-failed' : ''}`}
          >
            <button
              type="button"
              className="owui-tool-head"
              disabled={!hasDetails}
              onClick={() => setOpenIds((prev) => ({ ...prev, [tc.toolCallId]: !prev[tc.toolCallId] }))}
              aria-expanded={hasDetails ? isOpen : undefined}
            >
              {isRunning ? (
                <span className="owui-tool-spinner" aria-hidden="true" />
              ) : isFailed ? (
                <CloseIcon size={13} className="owui-tool-icon-fail" />
              ) : (
                <Icon size={14} className="owui-tool-icon-ok" />
              )}
              {subagent && <span className="owui-subagent-tag">Subagent</span>}
              <span className="owui-tool-title truncate" title={displayTitle}>
                {isRunning ? `実行中: ${displayTitle}` : displayTitle}
              </span>
              {tc.subagentState && tc.subagentState !== 'idle' && (
                <span className="muted-xs" style={{ marginLeft: 6 }}>
                  ({tc.subagentState})
                </span>
              )}
              {tc.diffStats && (
                <span className="activity-diff" aria-label={`${tc.diffStats.added} 行追加、${tc.diffStats.removed} 行削除`}>
                  <span className="activity-diff-added">+{tc.diffStats.added}</span>
                  <span className="activity-diff-removed">−{tc.diffStats.removed}</span>
                </span>
              )}
              {isFailed && <span className="owui-tool-fail-label">失敗</span>}
              {hasDetails && (
                <ChevronIcon size={13} dir={isOpen ? 'down' : 'right'} className="owui-disclosure-chevron" />
              )}
            </button>
            {isOpen && hasDetails && (
              <div className="owui-tool-body">
                <ToolLocations locations={tc.locations} {...fileLinks} />
                {tc.contentText && (
                  <MarkdownContent content={tc.contentText} messageStatus={messageStatus} {...fileLinks} />
                )}
                {tc.subagentThoughtsText && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Thoughts</div>
                    <MarkdownContent content={tc.subagentThoughtsText} messageStatus={messageStatus} {...fileLinks} />
                  </div>
                )}
                {tc.subagentToolCalls && tc.subagentToolCalls.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Tools ({tc.subagentToolCalls.length})</div>
                    {tc.subagentToolCalls.map((stc) => (
                      <div key={stc.toolCallId} className="muted-xs" style={{ marginTop: 2 }}>
                        [{stc.status}] {stc.title}
                        <ToolLocations locations={stc.locations} {...fileLinks} />
                        {stc.contentText && (
                          <MarkdownContent content={stc.contentText} messageStatus={toolOutputStatus(stc)} {...fileLinks} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {tc.subagentContentText && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Output</div>
                    <MarkdownContent content={tc.subagentContentText} messageStatus={messageStatus} {...fileLinks} />
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
});

const PermissionCard: React.FC<{
  perm: PendingPermissionRecord;
  clientId: string;
  onResolved: (perm: PendingPermissionRecord) => void;
}> = React.memo(({ perm, clientId, onResolved }) => {
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
});

const MessageRow: React.FC<{
  msg: MessageRecord;
  chatId?: string;
  clientId: string;
  queuePosition: number | null;
  msgPerms: PendingPermissionRecord[];
  msgArtifacts: ArtifactRecord[];
  onOpenArtifact: (artifact: ArtifactRecord) => void;
  onOpenAttachment: (att: AttachmentRef) => void;
  onPermissionUpdated: (perm: PendingPermissionRecord) => void;
  onResolveError: (msg: string) => void;
}> = React.memo(
  ({
    msg,
    chatId,
    clientId,
    queuePosition,
    msgPerms,
    msgArtifacts,
    onOpenArtifact,
    onOpenAttachment,
    onPermissionUpdated,
    onResolveError,
  }) => {
    const [copied, setCopied] = useState(false);
    const { blocks, answer, hasCurrentAnswer } = useMemo(() => getMessageActivity(msg), [msg]);
    const isWorking = msg.status === 'streaming' && !hasCurrentAnswer;

    const handleCopy = useCallback(async () => {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }, [answer]);

    if (msg.role === 'user') {
      return (
        <div className="msg-row user">
          <div className="user-bubble">
            {msg.attachments.length > 0 && (
              <div className="att-chip-row">
                {msg.attachments.map((att) => (
                  <button
                    key={att.artifactId}
                    type="button"
                    className="att-chip"
                    onClick={() => onOpenAttachment(att)}
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
      <div className="msg-row assistant">
        <div className="assistant-body">
          {msg.status === 'queued' && (
            <div className="queue-status-pill">
              待機中
              {queuePosition !== null && queuePosition > 0 ? `（順番 #${queuePosition}）` : '...'}
            </div>
          )}

          {blocks.length > 0 && (
            <details className="message-activity" open={isWorking}>
              <summary className="activity-summary">
                {isWorking ? <span className="owui-tool-spinner" aria-hidden="true" /> : <SparklesIcon size={15} />}
                <span>{isWorking ? '作業中' : '作業の履歴'}</span>
                <ChevronIcon size={13} dir="right" className="activity-chevron" />
              </summary>
              <div className="activity-timeline">
                {blocks.map((block) => {
                  if (block.kind === 'tools') {
                    return (
                      <ToolActivity
                        key={block.key}
                        tools={block.tools}
                        chatId={chatId}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    );
                  }
                  return (
                    <div key={block.key} className={block.kind === 'thoughts' ? 'activity-thoughts' : 'activity-commentary'}>
                      <MarkdownContent
                        content={block.text}
                        chatId={chatId}
                        messageStatus={msg.status}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {msg.sessionMessages && msg.sessionMessages.length > 0 && (
            <div className="owui-tools-list" aria-label="セッション間メッセージ">
              {msg.sessionMessages.map((sm) => (
                <div key={sm.messageId} className="owui-tool-item">
                  <div className="owui-tool-body" style={{ display: 'block' }}>
                    <div className="muted-xs">
                      セッション間メッセージ{sm.senderSessionId ? ` (${sm.senderSessionId})` : ''}
                      {!sm.done ? ' [受信中]' : ''}
                    </div>
                    {sm.contentText && (
                      <MarkdownContent
                        content={sm.contentText}
                        chatId={chatId}
                        messageStatus={sm.done ? 'completed' : 'streaming'}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {msgPerms.map((perm) => (
            <PermissionCard
              key={perm.id}
              perm={perm}
              clientId={clientId}
              onResolved={onPermissionUpdated}
            />
          ))}

          {answer ? (
            <div className="assistant-markdown">
              <MarkdownContent
                content={answer}
                chatId={chatId}
                messageStatus={msg.status}
                onOpenArtifact={onOpenArtifact}
                onResolveError={onResolveError}
              />
              {msg.status === 'streaming' && hasCurrentAnswer && <span className="stream-cursor" />}
            </div>
          ) : msg.status === 'streaming' && blocks.length === 0 ? (
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

          {msg.status !== 'streaming' && msg.status !== 'queued' && answer && (
            <div className="msg-actions">
              <button type="button" className="chip-btn" onClick={() => void handleCopy()}>
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                <span>{copied ? 'コピー済' : '回答をコピー'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

interface ChatComposerHandle {
  addFiles: (files: File[]) => void;
  showNotice: (msg: string) => void;
  focus: () => void;
}

interface ChatComposerProps {
  chatId?: string;
  availableCommands: AvailableCommandItem[];
  modelOptions: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'];
  currentModelValue: string;
  effortOptions: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'];
  currentEffortValue: string;
  isRunBusy: boolean;
  activeRunId: string | null;
  draftResetToken: number;
  hapticEnabled: boolean;
  externalDraftCommand?: { slug: string; token: number } | null;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onSendPrompt: (text: string, files: AttachmentRef[]) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  onCancelRun: (runId: string) => Promise<void>;
  onOpenSkills?: () => void;
  onPromptSubmitting?: () => void;
}

const ChatComposer = React.memo(
  React.forwardRef<ChatComposerHandle, ChatComposerProps>(
    (
      {
        chatId,
        availableCommands,
        modelOptions,
        currentModelValue,
        effortOptions,
        currentEffortValue,
        isRunBusy,
        activeRunId,
        draftResetToken,
        hapticEnabled,
        externalDraftCommand,
        onChangeModel,
        onChangeEffort,
        onDraftChange,
        onSendPrompt,
        onUploadFiles,
        onCancelRun,
        onOpenSkills,
        onPromptSubmitting,
      },
      ref
    ) => {
      const [inputText, setInputText] = useState('');
      const [stagedAttachments, setStagedAttachments] = useState<AttachmentRef[]>([]);
      const [uploading, setUploading] = useState(false);
      const [sending, setSending] = useState(false);
      const [uiNotice, setUiNotice] = useState<string | null>(null);
      const [slashForceOpen, setSlashForceOpen] = useState(false);
      const [slashDismissed, setSlashDismissed] = useState(false);
      const [slashActiveIdx, setSlashActiveIdx] = useState(0);

      const fileInputRef = useRef<HTMLInputElement>(null);
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const composerInnerRef = useRef<HTMLDivElement>(null);
      const prevChatIdRef = useRef<string | undefined>(chatId);
      const lastDraftRef = useRef<boolean | null>(null);

      useEffect(() => {
        const prev = prevChatIdRef.current;
        prevChatIdRef.current = chatId;
        if (prev !== undefined && prev !== chatId) {
          setStagedAttachments([]);
          setUiNotice(null);
          setSlashForceOpen(false);
          setSlashDismissed(false);
        }
      }, [chatId]);

      useEffect(() => {
        if (!draftResetToken) return;
        setInputText('');
        setStagedAttachments([]);
        setUiNotice(null);
        setSlashForceOpen(false);
        setSlashDismissed(false);
        textareaRef.current?.focus();
      }, [draftResetToken]);

      useEffect(() => {
        if (!externalDraftCommand) return;
        const prefix = `/${externalDraftCommand.slug} `;
        setInputText((prev) => {
          const trimmed = prev.trimStart();
          if (!trimmed || trimmed.startsWith('/')) {
            return prefix;
          }
          return `${prefix}${trimmed}`;
        });
        setSlashForceOpen(false);
        setSlashDismissed(false);
        window.setTimeout(() => textareaRef.current?.focus(), 30);
      }, [externalDraftCommand?.token, externalDraftCommand?.slug]);

      const hasDraft = inputText.trim().length > 0 || stagedAttachments.length > 0;
      useEffect(() => {
        if (lastDraftRef.current !== hasDraft) {
          lastDraftRef.current = hasDraft;
          onDraftChange?.(hasDraft);
        }
      }, [hasDraft, onDraftChange]);

      // Auto-resize composer textarea
      useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      }, [inputText]);

      const handleFilesSelected = useCallback(
        async (files: File[]) => {
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
        },
        [onUploadFiles]
      );

      useImperativeHandle(
        ref,
        () => ({
          addFiles: (files: File[]) => {
            void handleFilesSelected(files);
          },
          showNotice: (msg: string) => {
            setUiNotice(msg);
          },
          focus: () => {
            textareaRef.current?.focus();
          },
        }),
        [handleFilesSelected]
      );

      const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(inputText);
      const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : '';
      const slashOpen = slashForceOpen || (Boolean(slashMatch) && !slashDismissed);

      const filteredCommands = useMemo(() => {
        if (!slashOpen) return [];
        const list = [...availableCommands];
        if (!slashQuery) return list;
        return list
          .filter(
            (cmd) =>
              cmd.name.toLowerCase().includes(slashQuery) ||
              cmd.description.toLowerCase().includes(slashQuery)
          )
          .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return a.name.localeCompare(b.name);
          });
      }, [slashOpen, slashQuery, availableCommands]);

      useEffect(() => {
        setSlashActiveIdx(0);
      }, [slashQuery, slashOpen]);

      useEffect(() => {
        if (!slashOpen) return;
        const onPointerDown = (e: PointerEvent) => {
          if (composerInnerRef.current && !composerInnerRef.current.contains(e.target as Node)) {
            setSlashForceOpen(false);
            setSlashDismissed(true);
          }
        };
        window.addEventListener('pointerdown', onPointerDown);
        return () => window.removeEventListener('pointerdown', onPointerDown);
      }, [slashOpen]);

      const acceptSlashCommand = (cmd: AvailableCommandItem) => {
        const token = `/${cmd.name} `;
        setInputText((prev) => {
          if (/^\/[a-zA-Z0-9_-]*$/.test(prev)) {
            return token;
          }
          const cleaned = prev.trimStart();
          return cleaned ? `${token}${cleaned}` : token;
        });
        setSlashForceOpen(false);
        setSlashDismissed(false);
        window.setTimeout(() => textareaRef.current?.focus(), 10);
      };

      const configBusy = sending || uploading || isRunBusy;
      const canSend = !(sending || uploading || (!inputText.trim() && stagedAttachments.length === 0));
      const showStopInsteadOfSend = isRunBusy && Boolean(activeRunId) && !hasDraft && !sending;
      const isFollowupSendMode = isRunBusy && (hasDraft || sending);
      const useIosSwitchOverlay = isAppleTouchHapticsFallback() && hapticEnabled;

      const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const trimmed = inputText.trim();
        if ((!trimmed && stagedAttachments.length === 0) || sending || uploading) return;

        // Immediately dismiss smartphone soft keyboard and lock scroll to follow latest response
        textareaRef.current?.blur();
        if (
          typeof document !== 'undefined' &&
          document.activeElement instanceof HTMLElement &&
          composerInnerRef.current?.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }
        onPromptSubmitting?.();

        const toSendAttachments = stagedAttachments;
        const savedInput = inputText;
        setSending(true);
        setUiNotice(null);
        setInputText('');
        setStagedAttachments([]);
        setSlashForceOpen(false);
        setSlashDismissed(false);

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
        if (slashOpen) {
          if (e.key === 'Escape') {
            e.preventDefault();
            setSlashForceOpen(false);
            setSlashDismissed(true);
            return;
          }
          if (filteredCommands.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSlashActiveIdx((idx) => (idx + 1) % filteredCommands.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSlashActiveIdx((idx) => (idx - 1 + filteredCommands.length) % filteredCommands.length);
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              const chosen = filteredCommands[slashActiveIdx] ?? filteredCommands[0];
              if (chosen) acceptSlashCommand(chosen);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              if (slashMatch) {
                e.preventDefault();
                const chosen = filteredCommands[slashActiveIdx] ?? filteredCommands[0];
                if (chosen) acceptSlashCommand(chosen);
                return;
              }
            }
          }
        }

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

      return (
        <div className="composer-dock">
          <div className="composer-inner" ref={composerInnerRef}>
            {uiNotice && (
              <div className="composer-notice">
                <span>{uiNotice}</span>
                <button type="button" className="icon-btn-sm" onClick={() => setUiNotice(null)}>
                  <CloseIcon size={14} />
                </button>
              </div>
            )}

            {slashOpen && (
              <div className="slash-palette" role="listbox" aria-label="スキル・スラッシュコマンド候補">
                <div className="slash-palette-head">
                  <span className="row-actions">
                    <SparklesIcon size={13} />
                    <span>スキル / コマンド</span>
                  </span>
                  {onOpenSkills && (
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() => {
                        setSlashForceOpen(false);
                        setSlashDismissed(true);
                        onOpenSkills();
                      }}
                    >
                      スキル管理
                    </button>
                  )}
                </div>
                {filteredCommands.length === 0 ? (
                  <div className="slash-palette-empty">
                    <span>
                      {availableCommands.length === 0
                        ? '登録されたスキル・コマンドはまだありません'
                        : '一致するコマンドが見つかりません'}
                    </span>
                    {onOpenSkills && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => {
                          setSlashForceOpen(false);
                          setSlashDismissed(true);
                          onOpenSkills();
                        }}
                      >
                        スキルを作成・有効化
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="slash-palette-list">
                    {filteredCommands.map((cmd, idx) => (
                      <button
                        key={`${cmd.name}-${cmd.scope ?? cmd.source ?? 'cmd'}`}
                        type="button"
                        role="option"
                        aria-selected={idx === slashActiveIdx}
                        className={`slash-palette-item ${idx === slashActiveIdx ? 'active' : ''}`}
                        onMouseEnter={() => setSlashActiveIdx(idx)}
                        onClick={() => acceptSlashCommand(cmd)}
                      >
                        <div className="slash-item-top">
                          <span className="slash-item-name">/{cmd.name}</span>
                          <span className="slash-item-badge">
                            {cmd.scope === 'global'
                              ? 'グローバル'
                              : cmd.scope === 'project'
                                ? 'プロジェクト'
                                : cmd.scope === 'workspace'
                                  ? 'このチャット'
                                  : 'ACP'}
                          </span>
                        </div>
                        {cmd.description && (
                          <div className="slash-item-desc">{cmd.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
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
                onChange={(e) => {
                  setInputText(e.target.value);
                  setSlashDismissed(false);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  uploading
                    ? 'ファイルをアップロード中...'
                    : isRunBusy
                      ? 'フォローアップを入力（/ でスキル呼出）'
                      : 'Antigravity に聞く（/ でスキル呼出）'
                }
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

                  <button
                    type="button"
                    className={`composer-icon-btn ${slashOpen ? 'active' : ''}`}
                    onClick={() => {
                      setSlashForceOpen((v) => !v);
                      setSlashDismissed(false);
                      textareaRef.current?.focus();
                    }}
                    title="スキル / スラッシュコマンド一覧"
                    aria-label="スキル・コマンド一覧"
                  >
                    <SlashIcon size={16} />
                  </button>
                </div>

                <div className="composer-toolbar-right">
                  {(effortOptions.length > 0 || modelOptions.length > 0) && (
                    <EffortBar
                      options={effortOptions}
                      value={currentEffortValue}
                      modelOptions={modelOptions}
                      selectedModelId={currentModelValue}
                      disabled={configBusy}
                      onChange={onChangeEffort}
                      onChangeModel={onChangeModel}
                    />
                  )}

                  {isFollowupSendMode && (
                    <span className="followup-mode-badge" aria-hidden="true">
                      フォローアップ
                    </span>
                  )}

                  {showStopInsteadOfSend && activeRunId ? (
                    <div className="haptic-btn-shell">
                      <button
                        type="button"
                        className="stop-btn"
                        onClick={() => {
                          triggerHaptic('stop', hapticEnabled);
                          void onCancelRun(activeRunId);
                        }}
                        title="生成・キューを停止"
                        aria-label="生成・キューを停止"
                      >
                        <StopIcon size={14} />
                      </button>
                      {useIosSwitchOverlay && (
                        <label className="ios-haptic-switch-overlay" title="生成・キューを停止">
                          <input
                            type="checkbox"
                            {...({ switch: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                            aria-label="生成・キューを停止"
                            onChange={() => void onCancelRun(activeRunId)}
                          />
                        </label>
                      )}
                    </div>
                  ) : (
                    <div className="haptic-btn-shell">
                      <button
                        type="submit"
                        className={`send-btn ${isFollowupSendMode ? 'followup-btn' : ''}`}
                        disabled={!canSend}
                        title={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                        aria-label={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                      >
                        <SendIcon size={17} />
                      </button>
                      {useIosSwitchOverlay && canSend && (
                        <label
                          className="ios-haptic-switch-overlay"
                          title={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                        >
                          <input
                            type="checkbox"
                            {...({ switch: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                            aria-label={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                            onChange={() => void handleSubmit()}
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </form>

            <div className="composer-hint">
              <span>Enter で送信 / Shift+Enter で改行・別端末ともリアルタイム同期</span>
            </div>
          </div>
        </div>
      );
    }
  )
);

export const ChatView: React.FC<ChatViewProps> = React.memo(({
  chat,
  project,
  messages,
  artifacts,
  pendingPermissions,
  activeRun,
  sessionOptions,
  availableCommands = [],
  selectedModelId,
  selectedEffortValue,
  draftResetToken = 0,
  clientId,
  hapticEnabled = true,
  onChangeModel,
  onChangeEffort,
  onDraftChange,
  onSendPrompt,
  onUploadFiles,
  onCancelRun,
  onSyncProject,
  onOpenArtifact,
  onPermissionUpdated,
  onOpenSkills,
  externalDraftCommand,
}) => {
  const [syncingProj, setSyncingProj] = useState(false);

  const chatViewRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesRailRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);

  const isNearBottomRef = useRef(true);
  const followLockUntilRef = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);
  const prevScrollChatIdRef = useRef<string | undefined>(chat?.id);
  const prevMsgCountRef = useRef<number>(messages.length);

  const artifactsById = useMemo(() => {
    const map = new Map<string, ArtifactRecord>();
    for (const a of artifacts) map.set(a.id, a);
    return map;
  }, [artifacts]);

  const artifactsByIdRef = useRef(artifactsById);
  artifactsByIdRef.current = artifactsById;

  const prevMsgArtifactsCacheRef = useRef<Map<string, ArtifactRecord[]>>(new Map());
  const resolvedArtifactsByMsgId = useMemo(() => {
    const nextCache = new Map<string, ArtifactRecord[]>();
    for (const msg of messages) {
      const ids = msg.artifactIds;
      if (!ids || ids.length === 0) {
        nextCache.set(msg.id, EMPTY_ARTIFACTS);
        continue;
      }
      const list: ArtifactRecord[] = [];
      for (const id of ids) {
        const found = artifactsById.get(id);
        if (found) list.push(found);
      }
      if (list.length === 0) {
        nextCache.set(msg.id, EMPTY_ARTIFACTS);
        continue;
      }
      const prev = prevMsgArtifactsCacheRef.current.get(msg.id);
      if (prev && prev.length === list.length && prev.every((item, idx) => item === list[idx])) {
        nextCache.set(msg.id, prev);
      } else {
        nextCache.set(msg.id, list);
      }
    }
    prevMsgArtifactsCacheRef.current = nextCache;
    return nextCache;
  }, [messages, artifactsById]);

  const prevPermsCacheRef = useRef<Map<string, PendingPermissionRecord[]>>(new Map());
  const pendingPermsByRunId = useMemo(() => {
    const grouped = new Map<string, PendingPermissionRecord[]>();
    for (const p of pendingPermissions) {
      if (p.status !== 'pending') continue;
      let bucket = grouped.get(p.runId);
      if (!bucket) {
        bucket = [];
        grouped.set(p.runId, bucket);
      }
      bucket.push(p);
    }
    for (const [runId, nextList] of grouped.entries()) {
      const prev = prevPermsCacheRef.current.get(runId);
      if (prev && prev.length === nextList.length && prev.every((item, idx) => item === nextList[idx])) {
        grouped.set(runId, prev);
      }
    }
    prevPermsCacheRef.current = grouped;
    return grouped;
  }, [pendingPermissions]);

  const scheduleScrollToBottom = useCallback(() => {
    if (!isNearBottomRef.current) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = messagesScrollRef.current;
      if (el && isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  const handlePromptSubmitting = useCallback(() => {
    followLockUntilRef.current = Date.now() + 1200;
    isNearBottomRef.current = true;
    const el = messagesScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    if (Date.now() < followLockUntilRef.current) {
      isNearBottomRef.current = true;
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance < 120;
  }, []);

  const lastMsg = messages[messages.length - 1];
  const lastMsgToolSummary = useMemo(
    () => (lastMsg?.toolCalls ?? []).map((t) => `${t.toolCallId}:${t.status}`).join('|'),
    [lastMsg?.toolCalls]
  );

  useEffect(() => {
    const chatChanged = prevScrollChatIdRef.current !== chat?.id;
    prevScrollChatIdRef.current = chat?.id;
    const newMsgAdded = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    if (chatChanged || (newMsgAdded && lastMsg?.role === 'user')) {
      followLockUntilRef.current = Date.now() + 1200;
      isNearBottomRef.current = true;
    }
    scheduleScrollToBottom();
  }, [
    chat?.id,
    messages.length,
    lastMsg?.role,
    lastMsg?.status,
    lastMsg?.contentText.length,
    lastMsg?.thoughtsText.length,
    lastMsg?.artifactIds.length,
    lastMsgToolSummary,
    pendingPermissions.length,
    scheduleScrollToBottom,
  ]);

  useEffect(() => {
    const scrollEl = messagesScrollRef.current;
    const railEl = messagesRailRef.current;
    if (!scrollEl || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      if (Date.now() < followLockUntilRef.current) {
        isNearBottomRef.current = true;
      }
      scheduleScrollToBottom();
    });
    ro.observe(scrollEl);
    if (railEl) ro.observe(railEl);

    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const onVvResize = () => {
      if (Date.now() < followLockUntilRef.current) {
        isNearBottomRef.current = true;
      }
      scheduleScrollToBottom();
    };
    vv?.addEventListener('resize', onVvResize);

    return () => {
      ro.disconnect();
      vv?.removeEventListener('resize', onVvResize);
    };
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const openAttachmentRef = useCallback(
    (att: AttachmentRef) => {
      const found = artifactsByIdRef.current.get(att.artifactId);
      if (found) {
        onOpenArtifact(found);
        return;
      }
      void api
        .getArtifact(att.artifactId)
        .then((res) => {
          onOpenArtifact(res.artifact);
        })
        .catch(() => {
          composerRef.current?.showNotice('ファイルが見つかりませんでした。');
        });
    },
    [onOpenArtifact]
  );

  const handleResolveError = useCallback((message: string) => {
    composerRef.current?.showNotice(message);
  }, []);

  const modelOption = useMemo(
    () =>
      sessionOptions?.configOptions.find(
        (o) => o.id === sessionOptions.modelOptionId || o.category === 'model'
      ),
    [sessionOptions]
  );
  const effortOption = useMemo(
    () =>
      sessionOptions?.configOptions.find(
        (o) => o.id === sessionOptions.effortOptionId || o.category === 'thought_level'
      ),
    [sessionOptions]
  );
  const modelOptions = modelOption?.options ?? EMPTY_SELECT_OPTIONS;
  const effortOptions = effortOption?.options ?? EMPTY_SELECT_OPTIONS;
  const currentModelValue =
    selectedModelId || modelOption?.currentValue || modelOptions[0]?.value || '';
  const currentEffortValue =
    (effortOptions.some((o) => o.value === selectedEffortValue) ? selectedEffortValue : undefined) ||
    effortOption?.currentValue ||
    effortOptions[0]?.value ||
    '';

  const isRunBusy = Boolean(
    activeRun &&
      (activeRun.status === 'running' ||
        activeRun.status === 'queued' ||
        activeRun.status === 'awaiting_permission')
  );

  const isStaleProjectContext =
    Boolean(chat && project && project.contextVersion > chat.projectContextVersion);

  return (
    <div
      ref={chatViewRef}
      className="chat-view"
      onDragOver={(e) => {
        e.preventDefault();
        chatViewRef.current?.classList.add('drag-over');
      }}
      onDragLeave={(e) => {
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) {
          chatViewRef.current?.classList.remove('drag-over');
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        chatViewRef.current?.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) composerRef.current?.addFiles(files);
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

      <div ref={messagesScrollRef} className="messages-scroll" onScroll={handleMessagesScroll}>
        <div ref={messagesRailRef} className="messages-rail">
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
            messages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                chatId={chat?.id}
                clientId={clientId}
                queuePosition={
                  msg.status === 'queued' &&
                  activeRun?.id === msg.runId &&
                  activeRun.queuePosition > 0
                    ? activeRun.queuePosition
                    : null
                }
                msgPerms={msg.runId ? (pendingPermsByRunId.get(msg.runId) ?? EMPTY_PERMS) : EMPTY_PERMS}
                msgArtifacts={resolvedArtifactsByMsgId.get(msg.id) ?? EMPTY_ARTIFACTS}
                onOpenArtifact={onOpenArtifact}
                onOpenAttachment={openAttachmentRef}
                onPermissionUpdated={onPermissionUpdated}
                onResolveError={handleResolveError}
              />
            ))
          )}
        </div>
      </div>

      <ChatComposer
        ref={composerRef}
        chatId={chat?.id}
        availableCommands={availableCommands}
        modelOptions={modelOptions}
        currentModelValue={currentModelValue}
        effortOptions={effortOptions}
        currentEffortValue={currentEffortValue}
        isRunBusy={isRunBusy}
        activeRunId={activeRun?.id ?? null}
        draftResetToken={draftResetToken}
        hapticEnabled={hapticEnabled}
        externalDraftCommand={externalDraftCommand}
        onChangeModel={onChangeModel}
        onChangeEffort={onChangeEffort}
        onDraftChange={onDraftChange}
        onSendPrompt={onSendPrompt}
        onUploadFiles={onUploadFiles}
        onCancelRun={onCancelRun}
        onOpenSkills={onOpenSkills}
        onPromptSubmitting={handlePromptSubmitting}
      />
    </div>
  );
});
