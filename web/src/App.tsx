import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { SyncSocketClient, type WsConnectionStatus } from './api/ws';
import { AgyOnboarding } from './components/AgyOnboarding';
import { AuthScreen } from './components/AuthScreen';

const ArtifactViewerModal = React.lazy(() =>
  import('./components/ArtifactViewerModal').then((m) => ({ default: m.ArtifactViewerModal }))
);
import { ChatView } from './components/ChatView';
import { HeaderBar } from './components/HeaderBar';
import { ProjectModal } from './components/ProjectModal';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { WorkspaceDrawer } from './components/WorkspaceDrawer';
import type {
  AgyLoginFlowState,
  AgyProfile,
  ArtifactRecord,
  AttachmentRef,
  BootstrapResponse,
  ChatRecord,
  MessageRecord,
  ParsedSessionOptions,
  PendingPermissionRecord,
  ProjectRecord,
  QuotaSnapshotRecord,
  RunRecord,
  SyncEventEnvelope,
  ToolCallItem,
  UserPreferences,
  WebUser,
  WsIncomingMessage,
} from './types';

function applyThemeToDocument(theme: 'system' | 'light' | 'dark'): void {
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = effective;
}

function mergeDeltaText(existing: string, offset: number, chunk: string): { next: string; gapDetected: boolean } {
  if (offset === existing.length) {
    return { next: existing + chunk, gapDetected: false };
  }
  if (offset < existing.length) {
    const end = offset + chunk.length;
    if (end <= existing.length) {
      return { next: existing, gapDetected: false };
    }
    return { next: existing + chunk.slice(existing.length - offset), gapDetected: false };
  }
  // If an intermediate delta was missed between snapshot HTTP & WS attach
  return { next: existing + chunk, gapDetected: true };
}

export const App: React.FC = () => {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapMeta, setBootstrapMeta] = useState<Pick<
    BootstrapResponse,
    'userCount' | 'allowPublicSignup' | 'agyMode'
  >>({
    userCount: 0,
    allowPublicSignup: false,
    agyMode: 'real',
  });

  const [user, setUser] = useState<WebUser | null>(null);
  const [agyProfile, setAgyProfile] = useState<AgyProfile | null>(null);
  const [loginFlow, setLoginFlow] = useState<AgyLoginFlowState | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);

  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionRecord[]>([]);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [sessionOptions, setSessionOptions] = useState<ParsedSessionOptions | null>(null);
  const [contextUsage, setContextUsage] = useState<{ used: number; size: number } | null>(null);

  const [quota, setQuota] = useState<QuotaSnapshotRecord | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectModalTarget, setProjectModalTarget] = useState<ProjectRecord | null | undefined>(
    undefined
  );
  const [viewerArtifact, setViewerArtifact] = useState<ArtifactRecord | null>(null);

  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  const wsRef = useRef<SyncSocketClient | null>(null);
  const resyncDebounceRef = useRef<number | null>(null);

  const loadWorkspaceLists = useCallback(async () => {
    const [chatsRes, projRes, quotaRes] = await Promise.all([
      api.listChats(),
      api.listProjects(),
      api.getQuota(),
    ]);
    setChats(chatsRes.chats);
    setProjects(projRes.projects);
    setQuota(quotaRes.quota);
  }, []);

  const loadChatDetail = useCallback(async (chatId: string) => {
    const detail = await api.getChat(chatId);
    if (activeChatIdRef.current !== chatId) return;
    setMessages(detail.messages);
    setArtifacts(detail.artifacts);
    setPendingPermissions(detail.pendingPermissions);
    setActiveRun(detail.activeRun);
    setSessionOptions(detail.sessionOptions);
    setContextUsage(null);
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...detail.chat, activeRun: detail.activeRun } : c))
    );
  }, []);

  // Theme sync
  useEffect(() => {
    applyThemeToDocument(preferences?.theme ?? 'system');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if ((preferences?.theme ?? 'system') === 'system') {
        applyThemeToDocument('system');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preferences?.theme]);

  // Initial bootstrap
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const res = await api.bootstrap();
        if (!active) return;
        setBootstrapMeta({
          userCount: res.userCount,
          allowPublicSignup: res.allowPublicSignup,
          agyMode: res.agyMode,
        });
        if (res.authenticated && res.user) {
          setUser(res.user);
          setAgyProfile(res.agyProfile);
          setPreferences(res.preferences);
          setLoginFlow(res.loginFlow);
        }
      } finally {
        if (active) setBootstrapping(false);
      }
    };
    void init();
    return () => {
      active = false;
    };
  }, []);

  // Load chats & projects when authenticated
  useEffect(() => {
    if (!user) return;
    void loadWorkspaceLists();
  }, [user?.id, loadWorkspaceLists]);

  // Load detail when switching active chat
  useEffect(() => {
    if (!user || !activeChatId) {
      setMessages([]);
      setArtifacts([]);
      setPendingPermissions([]);
      setActiveRun(null);
      setSessionOptions(null);
      setContextUsage(null);
      return;
    }
    void loadChatDetail(activeChatId);
  }, [user?.id, activeChatId, loadChatDetail]);

  const scheduleActiveChatResync = useCallback(
    (chatId: string) => {
      if (resyncDebounceRef.current) clearTimeout(resyncDebounceRef.current);
      resyncDebounceRef.current = window.setTimeout(() => {
        if (activeChatIdRef.current === chatId) {
          void loadChatDetail(chatId);
        }
      }, 150);
    },
    [loadChatDetail]
  );

  const handleDurableEvent = useCallback((evt: SyncEventEnvelope) => {
    const p = evt.payload;
    const curChatId = activeChatIdRef.current;

    switch (evt.type) {
      case 'agy.login_progress': {
        const flow = p.loginFlow as AgyLoginFlowState | undefined;
        if (flow) setLoginFlow(flow);
        break;
      }
      case 'agy.auth_changed': {
        const prof = p.profile as AgyProfile | undefined;
        if (prof) setAgyProfile(prof);
        break;
      }
      case 'preferences.updated': {
        const prefs = p.preferences as UserPreferences | undefined;
        if (prefs) setPreferences(prefs);
        break;
      }
      case 'quota.updated': {
        const q = p.quota as QuotaSnapshotRecord | undefined;
        if (q) setQuota(q);
        break;
      }
      case 'project.created':
      case 'project.updated': {
        const proj = p.project as ProjectRecord | undefined;
        if (proj) {
          setProjects((prev) => {
            const idx = prev.findIndex((x) => x.id === proj.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = proj;
              return copy;
            }
            return [proj, ...prev];
          });
        }
        break;
      }
      case 'project.deleted': {
        const projectId = p.projectId as string | undefined;
        if (projectId) {
          setProjects((prev) => prev.filter((x) => x.id !== projectId));
          setChats((prev) =>
            prev.map((c) => (c.projectId === projectId ? { ...c, projectId: null } : c))
          );
        }
        break;
      }
      case 'chat.created': {
        const chat = p.chat as ChatRecord | undefined;
        if (chat) {
          setChats((prev) => (prev.some((c) => c.id === chat.id) ? prev : [chat, ...prev]));
        }
        break;
      }
      case 'chat.updated': {
        const chat = p.chat as ChatRecord | undefined;
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (chat) {
          setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, ...chat } : c)));
        }
        if (opts && evt.chatId === curChatId) {
          setSessionOptions(opts);
        }
        break;
      }
      case 'chat.config_updated': {
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (opts && evt.chatId === curChatId) {
          setSessionOptions(opts);
        }
        break;
      }
      case 'chat.deleted': {
        const chatId = p.chatId as string | undefined;
        if (chatId) {
          setChats((prev) => prev.filter((c) => c.id !== chatId));
          if (curChatId === chatId) setActiveChatId(null);
        }
        break;
      }
      case 'message.created': {
        const msgs = (p.messages as MessageRecord[] | undefined) ?? [];
        const run = p.run as RunRecord | undefined;
        const chat = p.chat as ChatRecord | undefined;
        if (chat) {
          setChats((prev) => {
            const others = prev.filter((c) => c.id !== chat.id);
            return [{ ...chat, activeRun: run ?? null }, ...others];
          });
        }
        if (evt.chatId === curChatId) {
          setMessages((prev) => {
            const copy = [...prev];
            for (const m of msgs) {
              if (!copy.some((x) => x.id === m.id)) copy.push(m);
            }
            return copy;
          });
          if (run) setActiveRun(run);
        }
        break;
      }
      case 'message.updated': {
        const msg = p.message as MessageRecord | undefined;
        if (msg && evt.chatId === curChatId) {
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id)
              ? prev.map((m) => (m.id === msg.id ? msg : m))
              : [...prev, msg]
          );
        }
        break;
      }
      case 'run.started': {
        const run = p.run as RunRecord | undefined;
        const msg = p.message as MessageRecord | undefined;
        if (run) {
          setChats((prev) =>
            prev.map((c) => (c.id === run.chatId ? { ...c, activeRun: run } : c))
          );
        }
        if (evt.chatId === curChatId) {
          if (run) setActiveRun(run);
          if (msg) {
            setMessages((prev) =>
              prev.some((m) => m.id === msg.id)
                ? prev.map((m) => (m.id === msg.id ? msg : m))
                : [...prev, msg]
            );
          }
        }
        break;
      }
      case 'run.finished': {
        const run = p.run as RunRecord | undefined;
        const msg = p.message as MessageRecord | undefined;
        if (run) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === run.chatId && c.activeRun?.id === run.id ? { ...c, activeRun: null } : c
            )
          );
        }
        if (evt.chatId === curChatId) {
          if (run) {
            setActiveRun((cur) => (cur?.id === run.id ? null : cur));
            setPendingPermissions((prev) => prev.filter((perm) => perm.runId !== run.id));
          }
          if (msg) {
            setMessages((prev) =>
              prev.some((m) => m.id === msg.id)
                ? prev.map((m) => (m.id === msg.id ? msg : m))
                : [...prev, msg]
            );
          }
        }
        break;
      }
      case 'permission.requested': {
        const perm = p.permission as PendingPermissionRecord | undefined;
        if (perm) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === perm.chatId && c.activeRun
                ? { ...c, activeRun: { ...c.activeRun, status: 'awaiting_permission' } }
                : c
            )
          );
          if (evt.chatId === curChatId) {
            setPendingPermissions((prev) =>
              prev.some((x) => x.id === perm.id) ? prev : [...prev, perm]
            );
          }
        }
        break;
      }
      case 'permission.resolved': {
        const perm = p.permission as PendingPermissionRecord | undefined;
        if (perm) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === perm.chatId && c.activeRun?.status === 'awaiting_permission'
                ? { ...c, activeRun: { ...c.activeRun, status: 'running' } }
                : c
            )
          );
          if (evt.chatId === curChatId) {
            setPendingPermissions((prev) => prev.filter((x) => x.id !== perm.id));
          }
        }
        break;
      }
      case 'artifact.created': {
        const art = p.artifact as ArtifactRecord | undefined;
        if (art && evt.chatId === curChatId) {
          setArtifacts((prev) => {
            const idx = prev.findIndex((x) => x.id === art.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = art;
              return copy;
            }
            return [art, ...prev];
          });
        }
        break;
      }
    }
  }, []);

  const handleEphemeralEvent = useCallback(
    (evt: Extract<WsIncomingMessage, { kind: 'ephemeral' }>['event']) => {
      const curChatId = activeChatIdRef.current;
      const p = evt.payload;

      if (evt.type === 'run.queue_position') {
        const runId = p.runId as string | undefined;
        const pos = Number(p.queuePosition ?? 0);
        if (evt.chatId === curChatId && runId) {
          setActiveRun((cur) => (cur?.id === runId ? { ...cur, queuePosition: pos } : cur));
        }
        return;
      }

      if (evt.chatId !== curChatId) return;

      if (evt.type === 'chat.context_usage') {
        setContextUsage({ used: Number(p.used ?? 0), size: Number(p.size ?? 0) });
        return;
      }

      if (evt.type === 'run.delta') {
        const messageId = p.messageId as string;
        const field = p.field as 'content' | 'thoughts';
        const offset = Number(p.offset ?? 0);
        const chunk = String(p.chunk ?? '');
        let gapDetected = false;

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            if (field === 'content') {
              const merged = mergeDeltaText(m.contentText, offset, chunk);
              if (merged.gapDetected) gapDetected = true;
              return { ...m, contentText: merged.next, status: 'streaming' };
            } else {
              const merged = mergeDeltaText(m.thoughtsText, offset, chunk);
              if (merged.gapDetected) gapDetected = true;
              return { ...m, thoughtsText: merged.next, status: 'streaming' };
            }
          })
        );
        if (gapDetected && evt.chatId) {
          scheduleActiveChatResync(evt.chatId);
        }
        return;
      }

      if (evt.type === 'run.tool_update') {
        const messageId = p.messageId as string;
        const toolCalls = (p.toolCalls as ToolCallItem[] | undefined) ?? [];
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, toolCalls } : m))
        );
      }
    },
    [scheduleActiveChatResync]
  );

  // Manage live WebSocket lifecycle cleanly per authenticated user
  useEffect(() => {
    if (!user) {
      wsRef.current?.stop();
      wsRef.current = null;
      return;
    }

    const client = new SyncSocketClient({
      onStatusChange: setWsStatus,
      onHello: (msg) => {
        if (msg.resyncRequired) {
          void loadWorkspaceLists();
          if (activeChatIdRef.current) void loadChatDetail(activeChatIdRef.current);
        } else {
          for (const evt of msg.events) {
            handleDurableEvent(evt);
          }
          // If an active chat exists, verify it caught up cleanly across background wake
          if (activeChatIdRef.current && msg.events.length === 0) {
            // noop when cleanly synchronized
          }
        }
      },
      onDurableEvent: handleDurableEvent,
      onEphemeralEvent: handleEphemeralEvent,
      onAuthLost: () => {
        setUser(null);
        setAgyProfile(null);
        setActiveChatId(null);
        setChats([]);
        setProjects([]);
      },
    });
    wsRef.current = client;
    client.start();

    return () => {
      client.stop();
      if (wsRef.current === client) wsRef.current = null;
    };
  }, [user?.id, loadWorkspaceLists, loadChatDetail, handleDurableEvent, handleEphemeralEvent]);

  const handleCreateChat = async (projectId: string | null = null) => {
    const res = await api.createChat({ projectId });
    setChats((prev) => [res.chat, ...prev.filter((c) => c.id !== res.chat.id)]);
    setActiveChatId(res.chat.id);
    if (res.sessionOptions) setSessionOptions(res.sessionOptions);
    return res.chat;
  };

  const ensureActiveChatForAction = async (): Promise<string> => {
    if (activeChatIdRef.current) return activeChatIdRef.current;
    const created = await handleCreateChat(null);
    return created.id;
  };

  const handleUploadFiles = async (files: File[]): Promise<AttachmentRef[]> => {
    const chatId = await ensureActiveChatForAction();
    const res = await api.uploadChatAttachments(chatId, files);
    return res.attachments;
  };

  const handleSendPrompt = async (text: string, files: AttachmentRef[]): Promise<void> => {
    const chatId = await ensureActiveChatForAction();
    const clientMessageId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const res = await api.sendMessage(chatId, {
      text,
      attachmentIds: files.map((f) => f.artifactId),
      clientMessageId,
    });

    setMessages((prev) => {
      const copy = [...prev];
      if (!copy.some((m) => m.id === res.userMessage.id)) copy.push(res.userMessage);
      if (!copy.some((m) => m.id === res.assistantMessage.id)) copy.push(res.assistantMessage);
      return copy;
    });
    setActiveRun(res.run);
  };

  const handleCancelRun = async (runId: string) => {
    if (!activeChatId) return;
    await api.cancelRun(activeChatId, runId);
  };

  const handleLogout = async (allDevices = false) => {
    try {
      if (allDevices) await api.logoutAll();
      else await api.logout();
    } catch {
      // clear UI even if already expired
    }
    wsRef.current?.stop();
    setUser(null);
    setAgyProfile(null);
    setActiveChatId(null);
    setChats([]);
    setProjects([]);
    setSettingsOpen(false);
    const refreshed = await api.bootstrap().catch(() => null);
    if (refreshed) {
      setBootstrapMeta({
        userCount: refreshed.userCount,
        allowPublicSignup: refreshed.allowPublicSignup,
        agyMode: refreshed.agyMode,
      });
    }
  };

  if (bootstrapping) {
    return (
      <div className="splash-shell">
        <div className="brand-mark lg">A</div>
        <div className="muted-sm">起動中...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        userCount={bootstrapMeta.userCount}
        allowPublicSignup={bootstrapMeta.allowPublicSignup}
        agyMode={bootstrapMeta.agyMode}
        onAuthenticated={(payload) => {
          setUser(payload.user);
          setAgyProfile(payload.agyProfile);
          setPreferences(payload.preferences);
          setLoginFlow(payload.loginFlow);
        }}
      />
    );
  }

  // Strictly enforce initial / unauthenticated Antigravity account binding before chat UI
  if (!agyProfile || agyProfile.authStatus !== 'authenticated') {
    return (
      <AgyOnboarding
        user={user}
        profile={agyProfile}
        loginFlow={loginFlow}
        agyMode={bootstrapMeta.agyMode}
        onUpdated={({ profile, loginFlow: nextFlow }) => {
          setAgyProfile(profile);
          if (nextFlow !== undefined) setLoginFlow(nextFlow);
        }}
        onLogout={() => void handleLogout(false)}
      />
    );
  }

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeProject =
    activeChat?.projectId ? projects.find((p) => p.id === activeChat.projectId) ?? null : null;

  return (
    <div className="app-shell">
      <Sidebar
        openMobile={sidebarMobileOpen}
        user={user}
        agyProfile={agyProfile}
        chats={chats}
        projects={projects}
        activeChatId={activeChatId}
        onCloseMobile={() => setSidebarMobileOpen(false)}
        onNewChat={(projId) => void handleCreateChat(projId ?? null)}
        onSelectChat={(id) => {
          setActiveChatId(id);
          setWorkspaceOpen(false);
        }}
        onRenameChat={async (chatId, title) => {
          const res = await api.patchChat(chatId, { title });
          setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, ...res.chat } : c)));
        }}
        onDeleteChat={async (chatId) => {
          await api.deleteChat(chatId);
          setChats((prev) => prev.filter((c) => c.id !== chatId));
          if (activeChatId === chatId) setActiveChatId(null);
        }}
        onOpenProjectModal={(proj) => setProjectModalTarget(proj)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main-pane">
        <HeaderBar
          activeChat={activeChat}
          sessionOptions={sessionOptions}
          agyProfile={agyProfile}
          quota={quota}
          quotaRefreshing={quotaRefreshing}
          wsStatus={wsStatus}
          contextUsage={contextUsage}
          workspaceCount={artifacts.length}
          workspaceOpen={workspaceOpen}
          onOpenSidebar={() => setSidebarMobileOpen(true)}
          onChangeModel={async (modelId) => {
            if (!activeChat) return;
            const res = await api.patchChat(activeChat.id, { modelId });
            setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
            if (res.sessionOptions) setSessionOptions(res.sessionOptions);
          }}
          onChangeEffort={async (effortValue) => {
            if (!activeChat) return;
            const res = await api.patchChat(activeChat.id, { effortValue });
            setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
            if (res.sessionOptions) setSessionOptions(res.sessionOptions);
          }}
          onRefreshQuota={async () => {
            setQuotaRefreshing(true);
            try {
              const res = await api.refreshQuota();
              setQuota(res.quota);
            } finally {
              setQuotaRefreshing(false);
            }
          }}
          onToggleWorkspace={() => setWorkspaceOpen((o) => !o)}
        />

        <div className="content-stage">
          <ChatView
            chat={activeChat}
            project={activeProject}
            messages={messages}
            artifacts={artifacts}
            pendingPermissions={pendingPermissions}
            activeRun={activeRun}
            clientId={wsRef.current?.getClientId() ?? 'local'}
            onSendPrompt={handleSendPrompt}
            onUploadFiles={handleUploadFiles}
            onCancelRun={handleCancelRun}
            onSyncProject={async () => {
              if (!activeChat) return;
              const res = await api.syncChatProject(activeChat.id);
              setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
              await loadChatDetail(activeChat.id);
            }}
            onOpenArtifact={(art) => setViewerArtifact(art)}
            onPermissionUpdated={(perm) => {
              setPendingPermissions((prev) => prev.filter((x) => x.id !== perm.id));
            }}
          />

          {workspaceOpen && activeChat && (
            <WorkspaceDrawer
              chatId={activeChat.id}
              artifacts={artifacts}
              onClose={() => setWorkspaceOpen(false)}
              onOpenArtifact={(art) => setViewerArtifact(art)}
            />
          )}
        </div>
      </main>

      {settingsOpen && preferences && (
        <SettingsModal
          user={user}
          agyProfile={agyProfile}
          loginFlow={loginFlow}
          preferences={preferences}
          agyMode={bootstrapMeta.agyMode}
          onClose={() => setSettingsOpen(false)}
          onUpdatePreferences={(next) => setPreferences(next)}
          onUpdateAgy={({ profile, loginFlow: nextFlow }) => {
            setAgyProfile(profile);
            if (nextFlow !== undefined) setLoginFlow(nextFlow);
          }}
          onLogout={(all) => void handleLogout(all)}
        />
      )}

      {projectModalTarget !== undefined && (
        <ProjectModal
          project={projectModalTarget}
          onClose={() => setProjectModalTarget(undefined)}
          onSaved={(saved) => {
            setProjects((prev) => {
              const idx = prev.findIndex((p) => p.id === saved.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = saved;
                return copy;
              }
              return [saved, ...prev];
            });
          }}
          onDeleted={(projectId) => {
            setProjects((prev) => prev.filter((p) => p.id !== projectId));
          }}
          onStartChatInProject={(projectId) => {
            void handleCreateChat(projectId);
          }}
        />
      )}

      {viewerArtifact && (
        <Suspense
          fallback={
            <div className="modal-backdrop">
              <div className="modal-card modal-md" style={{ padding: 24, textAlign: 'center' }}>
                ビューアを読込中...
              </div>
            </div>
          }
        >
          <ArtifactViewerModal
            artifact={viewerArtifact}
            projects={projects}
            onClose={() => setViewerArtifact(null)}
            onCopiedToProject={(updatedProj) => {
              setProjects((prev) => prev.map((p) => (p.id === updatedProj.id ? updatedProj : p)));
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
