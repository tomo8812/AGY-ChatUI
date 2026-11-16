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
import {
  ensurePushSubscribed,
  getActivePushSubscription,
  isNotificationSupported,
  showBrowserNotification,
  unsubscribePushOnDevice,
} from './utils/notifications';
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
  SandboxStatus,
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
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', effective === 'dark' ? '#000000' : '#ffffff');
  }
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
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);

  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftCreatedChat, setDraftCreatedChat] = useState<ChatRecord | null>(null);
  const [draftResetToken, setDraftResetToken] = useState(0);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionRecord[]>([]);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [sessionOptions, setSessionOptions] = useState<ParsedSessionOptions | null>(null);
  const [userOptions, setUserOptions] = useState<ParsedSessionOptions | null>(null);
  const [contextUsage, setContextUsage] = useState<{ used: number; size: number } | null>(null);

  const [quota, setQuota] = useState<QuotaSnapshotRecord | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const [pendingUpdateBuild, setPendingUpdateBuild] = useState<string | null>(null);
  const [hasComposerDraft, setHasComposerDraft] = useState(false);

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
  const chatsRef = useRef<ChatRecord[]>([]);
  chatsRef.current = chats;
  const messagesRef = useRef<MessageRecord[]>([]);
  messagesRef.current = messages;
  const activeRunRef = useRef<RunRecord | null>(null);
  activeRunRef.current = activeRun;
  const draftCreatedChatRef = useRef<ChatRecord | null>(null);
  draftCreatedChatRef.current = draftCreatedChat;
  const skipNextLoadChatIdRef = useRef<string | null>(null);
  const localNotifiedRunsRef = useRef<Set<string>>(new Set());

  const initialBuildIdRef = useRef<string | null>(null);
  const lastHealthCheckRef = useRef<number>(0);
  const quotaRef = useRef<QuotaSnapshotRecord | null>(null);
  quotaRef.current = quota;
  const quotaRefreshingRef = useRef(false);
  const agyAuthRef = useRef(false);
  agyAuthRef.current = agyProfile?.authStatus === 'authenticated';
  const prevAgyAuthRef = useRef(false);
  const preferencesRef = useRef<UserPreferences | null>(null);
  preferencesRef.current = preferences;

  const wsRef = useRef<SyncSocketClient | null>(null);
  const resyncDebounceRef = useRef<number | null>(null);

  const cleanupEmptyDraftChat = useCallback(() => {
    const draftChat = draftCreatedChatRef.current;
    if (!draftChat) return;
    draftCreatedChatRef.current = null;
    setDraftCreatedChat(null);
    if (
      activeChatIdRef.current !== draftChat.id ||
      (messagesRef.current.length === 0 && !activeRunRef.current)
    ) {
      void api.deleteChat(draftChat.id).catch(() => {});
    }
  }, []);

  const notifyDetectedBuild = useCallback((nextBuildId?: string | null) => {
    if (!nextBuildId) return;
    if (!initialBuildIdRef.current) {
      initialBuildIdRef.current = nextBuildId;
      return;
    }
    if (nextBuildId !== initialBuildIdRef.current) {
      setPendingUpdateBuild((prev) => prev || nextBuildId);
    }
  }, []);

  const triggerQuotaRefresh = useCallback(async (auto: boolean) => {
    if (quotaRefreshingRef.current) return;
    if (auto) {
      const cur = quotaRef.current;
      if (cur && cur.fetchedAt > 0 && cur.status === 'ok' && Date.now() - cur.fetchedAt < 5 * 60 * 1000) {
        return;
      }
    }
    quotaRefreshingRef.current = true;
    if (!auto) setQuotaRefreshing(true);
    try {
      const res = await api.refreshQuota(auto);
      quotaRef.current = res.quota;
      setQuota(res.quota);
    } catch {
      // Ignore silent auto-refresh failures; manual errors can propagate only if needed
    } finally {
      quotaRefreshingRef.current = false;
      if (!auto) setQuotaRefreshing(false);
    }
  }, []);

  const loadWorkspaceLists = useCallback(async () => {
    const [chatsRes, projRes, quotaRes] = await Promise.all([
      api.listChats(),
      api.listProjects(),
      api.getQuota(),
    ]);
    setChats(chatsRes.chats);
    setProjects(projRes.projects);
    quotaRef.current = quotaRes.quota;
    setQuota(quotaRes.quota);
    if (
      agyAuthRef.current &&
      (!quotaRes.quota.fetchedAt || Date.now() - quotaRes.quota.fetchedAt >= 10 * 60 * 1000)
    ) {
      void triggerQuotaRefresh(true);
    }
  }, [triggerQuotaRefresh]);

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
        if (res.buildId) {
          initialBuildIdRef.current = res.buildId;
        }
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
          setSandboxStatus(res.sandbox ?? null);
        } else {
          setSandboxStatus(null);
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

  // Periodic + focus-based backend build check & PWA Service Worker update notification
  useEffect(() => {
    const onSwUpdate = () => {
      setPendingUpdateBuild((prev) => prev || 'sw-update');
    };
    window.addEventListener('agy:app-update-detected', onSwUpdate);

    const checkServerBuild = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastHealthCheckRef.current < 60_000) return;
      lastHealthCheckRef.current = now;
      void api
        .getHealth()
        .then((res) => {
          notifyDetectedBuild(res.buildId);
        })
        .catch(() => {});
    };

    const onVisibility = () => checkServerBuild();
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(checkServerBuild, 5 * 60 * 1000);

    return () => {
      window.removeEventListener('agy:app-update-detected', onSwUpdate);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, [notifyDetectedBuild]);

  // Auto-reload safely when a new build is detected and no work is in progress
  const isSafeToReload =
    !hasComposerDraft &&
    !activeRun &&
    loginFlow?.status !== 'awaiting_url' &&
    loginFlow?.status !== 'awaiting_code' &&
    loginFlow?.status !== 'verifying';

  useEffect(() => {
    if (!pendingUpdateBuild || !isSafeToReload) return;
    try {
      if (pendingUpdateBuild === 'sw-update') {
        const lastSwReload = Number(sessionStorage.getItem('agy_last_sw_reload_ts') || '0');
        if (Date.now() - lastSwReload < 30_000) return;
      } else if (sessionStorage.getItem('agy_reloaded_build') === pendingUpdateBuild) {
        return;
      }
    } catch {
      // continue if sessionStorage unavailable
    }

    const timer = window.setTimeout(() => {
      try {
        if (pendingUpdateBuild === 'sw-update') {
          sessionStorage.setItem('agy_last_sw_reload_ts', String(Date.now()));
        } else {
          sessionStorage.setItem('agy_reloaded_build', pendingUpdateBuild);
        }
      } catch {
        // ignore
      }
      window.location.reload();
    }, 900);

    return () => clearTimeout(timer);
  }, [pendingUpdateBuild, isSafeToReload]);

  // Load chats & projects when authenticated
  useEffect(() => {
    if (!user) return;
    void loadWorkspaceLists();
  }, [user?.id, loadWorkspaceLists]);

  // Open target chat from ?chatId=... query param or notification click events
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const targetChatId = params.get('chatId');
    if (targetChatId) {
      cleanupEmptyDraftChat();
      setDraftProjectId(null);
      setActiveChatId(targetChatId);
      setWorkspaceOpen(false);
      setSidebarMobileOpen(false);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [user?.id, cleanupEmptyDraftChat]);

  useEffect(() => {
    const onOpenChat = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (chatId) {
        cleanupEmptyDraftChat();
        setDraftProjectId(null);
        setActiveChatId(chatId);
        setWorkspaceOpen(false);
        setSidebarMobileOpen(false);
      }
    };
    window.addEventListener('agy:open-chat', onOpenChat);

    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onSwMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'OPEN_CHAT' && typeof event.data.chatId === 'string') {
        cleanupEmptyDraftChat();
        setDraftProjectId(null);
        setActiveChatId(event.data.chatId);
        setWorkspaceOpen(false);
        setSidebarMobileOpen(false);
      }
    };
    sw?.addEventListener('message', onSwMessage);

    return () => {
      window.removeEventListener('agy:open-chat', onOpenChat);
      sw?.removeEventListener('message', onSwMessage);
    };
  }, [cleanupEmptyDraftChat]);

  // Automatically sync browser Push subscription if notifyOnResponse is ON and permission is already granted
  useEffect(() => {
    if (!user || !preferences?.notifyOnResponse) return;
    if (!isNotificationSupported() || Notification.permission !== 'granted') return;
    void ensurePushSubscribed();
  }, [user?.id, preferences?.notifyOnResponse]);

  // Probe default model/effort options for welcome screen & run low-frequency quota background refresh
  const isAgyAuthenticated = agyProfile?.authStatus === 'authenticated';
  useEffect(() => {
    const justAuthenticated = !prevAgyAuthRef.current && isAgyAuthenticated;
    prevAgyAuthRef.current = isAgyAuthenticated;

    if (!user || !isAgyAuthenticated) {
      setUserOptions(null);
      return;
    }

    let active = true;
    void api
      .getAgyOptions(preferencesRef.current?.defaultModelId ?? null)
      .then((res) => {
        if (active && res.sessionOptions) {
          setUserOptions(res.sessionOptions);
        }
      })
      .catch(() => {});

    if (justAuthenticated && quotaRef.current && quotaRef.current.status !== 'ok') {
      void triggerQuotaRefresh(true);
    }

    const maybeRefreshQuota = () => {
      if (document.visibilityState !== 'visible') return;
      const cur = quotaRef.current;
      if (cur && (!cur.fetchedAt || Date.now() - cur.fetchedAt >= 15 * 60 * 1000)) {
        void triggerQuotaRefresh(true);
      }
    };

    const interval = window.setInterval(maybeRefreshQuota, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', maybeRefreshQuota);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', maybeRefreshQuota);
    };
  }, [user?.id, isAgyAuthenticated, triggerQuotaRefresh]);

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
    if (skipNextLoadChatIdRef.current === activeChatId) {
      skipNextLoadChatIdRef.current = null;
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
          setDraftProjectId((prev) => (prev === projectId ? null : prev));
        }
        break;
      }
      case 'chat.created': {
        // Un-sent 0-message chats stay out of sidebar history until the first message is sent
        break;
      }
      case 'chat.updated': {
        const chat = p.chat as ChatRecord | undefined;
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (chat) {
          setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, ...chat } : c)));
          setDraftCreatedChat((prev) => (prev && prev.id === chat.id ? { ...prev, ...chat } : prev));
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
          setDraftCreatedChat((prev) => (prev && prev.id === chatId ? null : prev));
          if (curChatId === chatId) setActiveChatId(null);
        }
        break;
      }
      case 'message.created': {
        const msgs = (p.messages as MessageRecord[] | undefined) ?? [];
        const run = p.run as RunRecord | undefined;
        const chat = p.chat as ChatRecord | undefined;
        if (chat) {
          if (draftCreatedChatRef.current?.id === chat.id) {
            draftCreatedChatRef.current = null;
            setDraftCreatedChat(null);
          }
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
        if (
          run &&
          run.status !== 'cancelled' &&
          preferencesRef.current?.notifyOnResponse &&
          Date.now() - evt.createdAt < 30_000 &&
          !localNotifiedRunsRef.current.has(run.id) &&
          isNotificationSupported() &&
          Notification.permission === 'granted' &&
          (document.visibilityState !== 'visible' || !document.hasFocus() || evt.chatId !== curChatId)
        ) {
          if (localNotifiedRunsRef.current.size > 200) {
            localNotifiedRunsRef.current.clear();
          }
          localNotifiedRunsRef.current.add(run.id);

          const chatTitle =
            chatsRef.current.find((c) => c.id === run.chatId)?.title || 'Antigravity Chat';
          const preview = (msg?.contentText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const body =
            run.status === 'error'
              ? run.errorMessage || '応答の生成中にエラーが発生しました。'
              : preview || '応答が完了しました。';
          const title = run.status === 'error' ? `エラーで終了 — ${chatTitle}` : chatTitle;

          void getActivePushSubscription().then((sub) => {
            if (!sub) {
              void showBrowserNotification({
                title,
                body,
                tag: `run-${run.id}`,
                chatId: run.chatId,
              });
            }
          });
        }
        const curQuota = quotaRef.current;
        if (!curQuota?.fetchedAt || Date.now() - curQuota.fetchedAt >= 5 * 60 * 1000) {
          void triggerQuotaRefresh(true);
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
  }, [triggerQuotaRefresh]);

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
        notifyDetectedBuild(msg.buildId);
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
        setSandboxStatus(null);
        setUserOptions(null);
        setSessionOptions(null);
        setQuota(null);
        draftCreatedChatRef.current = null;
        setDraftCreatedChat(null);
        setDraftProjectId(null);
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
  }, [user?.id, loadWorkspaceLists, loadChatDetail, handleDurableEvent, handleEphemeralEvent, notifyDetectedBuild]);

  const activeChat =
    chats.find((c) => c.id === activeChatId) ??
    (draftCreatedChat?.id === activeChatId ? draftCreatedChat : null);
  const effectiveProjectId = activeChat ? activeChat.projectId : draftProjectId;
  const activeProject =
    effectiveProjectId ? projects.find((p) => p.id === effectiveProjectId) ?? null : null;

  const effectiveSessionOptions = activeChat ? (sessionOptions ?? userOptions) : userOptions;
  const activeModelOption = effectiveSessionOptions?.configOptions.find(
    (o) => o.id === effectiveSessionOptions.modelOptionId || o.category === 'model'
  );
  const activeEffortOption = effectiveSessionOptions?.configOptions.find(
    (o) => o.id === effectiveSessionOptions.effortOptionId || o.category === 'thought_level'
  );
  const selectedModelId =
    (activeChat ? activeChat.modelId : preferences?.defaultModelId) ||
    activeModelOption?.currentValue ||
    activeModelOption?.options[0]?.value ||
    '';
  const rawEffortValue =
    (activeChat ? activeChat.effortValue : preferences?.defaultEffortValue) ||
    activeEffortOption?.currentValue ||
    activeEffortOption?.options[0]?.value ||
    '';
  const selectedEffortValue =
    activeEffortOption?.options.some((o) => o.value === rawEffortValue)
      ? rawEffortValue
      : activeEffortOption?.currentValue || activeEffortOption?.options[0]?.value || rawEffortValue;

  const handleStartDraftChat = (projectId: string | null = null) => {
    cleanupEmptyDraftChat();
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setDraftProjectId(projectId);
    setMessages([]);
    setArtifacts([]);
    setPendingPermissions([]);
    setActiveRun(null);
    setSessionOptions(null);
    setContextUsage(null);
    setWorkspaceOpen(false);
    setHasComposerDraft(false);
    setDraftResetToken((t) => t + 1);
  };

  const createDraftBackedChat = async (): Promise<ChatRecord> => {
    const res = await api.createChat({
      projectId: draftProjectId,
      modelId: selectedModelId || null,
      effortValue: selectedEffortValue || null,
    });
    draftCreatedChatRef.current = res.chat;
    setDraftCreatedChat(res.chat);
    setDraftProjectId(null);
    if (res.sessionOptions) setSessionOptions(res.sessionOptions);
    skipNextLoadChatIdRef.current = res.chat.id;
    activeChatIdRef.current = res.chat.id;
    setActiveChatId(res.chat.id);
    return res.chat;
  };

  const handleChangeModel = async (modelId: string) => {
    if (activeChat) {
      const res = await api.patchChat(activeChat.id, { modelId });
      setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
      setDraftCreatedChat((prev) =>
        prev && prev.id === activeChat.id ? { ...prev, ...res.chat } : prev
      );
      if (res.sessionOptions) setSessionOptions(res.sessionOptions);
      return;
    }

    setPreferences((prev) => (prev ? { ...prev, defaultModelId: modelId } : prev));
    const [prefRes, optRes] = await Promise.all([
      api.updatePreferences({ defaultModelId: modelId }),
      api.getAgyOptions(modelId),
    ]);
    let nextPrefs = prefRes.preferences;
    if (optRes.sessionOptions) {
      setUserOptions(optRes.sessionOptions);
      const nextEffortOpt = optRes.sessionOptions.configOptions.find(
        (o) => o.id === optRes.sessionOptions?.effortOptionId || o.category === 'thought_level'
      );
      if (
        nextEffortOpt &&
        nextPrefs.defaultEffortValue &&
        !nextEffortOpt.options.some((o) => o.value === nextPrefs.defaultEffortValue)
      ) {
        const fallbackEffort =
          nextEffortOpt.currentValue || nextEffortOpt.options[0]?.value || null;
        if (fallbackEffort) {
          const synced = await api.updatePreferences({ defaultEffortValue: fallbackEffort });
          nextPrefs = synced.preferences;
        }
      }
    }
    setPreferences(nextPrefs);
  };

  const handleChangeEffort = async (effortValue: string) => {
    if (activeChat) {
      const res = await api.patchChat(activeChat.id, { effortValue });
      setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
      setDraftCreatedChat((prev) =>
        prev && prev.id === activeChat.id ? { ...prev, ...res.chat } : prev
      );
      if (res.sessionOptions) setSessionOptions(res.sessionOptions);
      return;
    }

    setPreferences((prev) => (prev ? { ...prev, defaultEffortValue: effortValue } : prev));
    setUserOptions((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        currentEffortValue: effortValue,
        configOptions: prev.configOptions.map((o) =>
          o.id === prev.effortOptionId || o.category === 'thought_level'
            ? { ...o, currentValue: effortValue }
            : o
        ),
      };
    });
    const res = await api.updatePreferences({ defaultEffortValue: effortValue });
    setPreferences(res.preferences);
  };

  const handleManualReloadUpdate = () => {
    if (pendingUpdateBuild) {
      try {
        if (pendingUpdateBuild === 'sw-update') {
          sessionStorage.setItem('agy_last_sw_reload_ts', String(Date.now()));
        } else {
          sessionStorage.setItem('agy_reloaded_build', pendingUpdateBuild);
        }
      } catch {
        // ignore
      }
    }
    window.location.reload();
  };

  const ensureActiveChatForAction = async (): Promise<string> => {
    if (activeChatIdRef.current) return activeChatIdRef.current;
    const created = await createDraftBackedChat();
    return created.id;
  };

  const handleUploadFiles = async (files: File[]): Promise<AttachmentRef[]> => {
    const chatId = await ensureActiveChatForAction();
    const res = await api.uploadChatAttachments(chatId, files);
    return res.attachments;
  };

  const handleSendPrompt = async (text: string, files: AttachmentRef[]): Promise<void> => {
    const existingId = activeChatIdRef.current;
    const wasDraft = !existingId || draftCreatedChatRef.current?.id === existingId;
    const chatId = existingId || (await createDraftBackedChat()).id;
    const clientMessageId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const res = await api.sendMessage(chatId, {
      text,
      attachmentIds: files.map((f) => f.artifactId),
      clientMessageId,
    });

    const draftSnap = draftCreatedChatRef.current;
    if (draftSnap?.id === chatId) {
      draftCreatedChatRef.current = null;
      setDraftCreatedChat(null);
    }
    const promotedChat = res.chat ?? (wasDraft && draftSnap?.id === chatId ? draftSnap : undefined);
    if (promotedChat) {
      setChats((prev) => [
        { ...promotedChat, activeRun: res.run },
        ...prev.filter((c) => c.id !== promotedChat.id),
      ]);
    }

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
      await unsubscribePushOnDevice().catch(() => {});
      if (allDevices) await api.logoutAll();
      else await api.logout();
    } catch {
      // clear UI even if already expired
    }
    wsRef.current?.stop();
    setUser(null);
    setAgyProfile(null);
    setSandboxStatus(null);
    setUserOptions(null);
    setSessionOptions(null);
    setQuota(null);
    setHasComposerDraft(false);
    draftCreatedChatRef.current = null;
    setDraftCreatedChat(null);
    setDraftProjectId(null);
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
          setSandboxStatus(payload.sandbox ?? null);
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
        onNewChat={(projId) => handleStartDraftChat(projId ?? null)}
        onSelectChat={(id) => {
          if (draftCreatedChatRef.current?.id !== id) {
            cleanupEmptyDraftChat();
          }
          setDraftProjectId(null);
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
          selectedModelId={selectedModelId}
          agyProfile={agyProfile}
          quota={quota}
          quotaRefreshing={quotaRefreshing}
          wsStatus={wsStatus}
          contextUsage={contextUsage}
          workspaceCount={artifacts.length}
          workspaceOpen={workspaceOpen}
          onOpenSidebar={() => setSidebarMobileOpen(true)}
          onNewChat={() => handleStartDraftChat(null)}
          onRefreshQuota={() => void triggerQuotaRefresh(false)}
          onToggleWorkspace={() => setWorkspaceOpen((o) => !o)}
        />

        {pendingUpdateBuild && (
          <div className="update-banner" role="status">
            <span>
              {isSafeToReload
                ? '新しいバージョンを検知しました。自動的に最新画面へ更新します...'
                : '新しいバージョンが利用可能です（送信中・入力中の作業完了後に自動更新されます）'}
            </span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={handleManualReloadUpdate}>
              今すぐ更新
            </button>
          </div>
        )}

        <div className="content-stage">
          <ChatView
            chat={activeChat}
            project={activeProject}
            messages={messages}
            artifacts={artifacts}
            pendingPermissions={pendingPermissions}
            activeRun={activeRun}
            sessionOptions={effectiveSessionOptions}
            selectedModelId={selectedModelId}
            selectedEffortValue={selectedEffortValue}
            draftResetToken={draftResetToken}
            clientId={wsRef.current?.getClientId() ?? 'local'}
            onChangeModel={(modelId) => void handleChangeModel(modelId)}
            onChangeEffort={(effortValue) => void handleChangeEffort(effortValue)}
            onDraftChange={setHasComposerDraft}
            onSendPrompt={handleSendPrompt}
            onUploadFiles={handleUploadFiles}
            onCancelRun={handleCancelRun}
            onSyncProject={async () => {
              if (!activeChat) return;
              const res = await api.syncChatProject(activeChat.id);
              setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, ...res.chat } : c)));
              setDraftCreatedChat((prev) =>
                prev && prev.id === activeChat.id ? { ...prev, ...res.chat } : prev
              );
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
          sandbox={sandboxStatus}
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
            handleStartDraftChat(projectId);
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
