import React, { useMemo, useState } from 'react';
import type { AgyProfile, ChatRecord, ProjectRecord, WebUser } from '../types';
import {
  CloseIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  TrashIcon,
} from './Icons';

interface SidebarProps {
  openMobile: boolean;
  user: WebUser;
  agyProfile: AgyProfile | null;
  chats: ChatRecord[];
  projects: ProjectRecord[];
  activeChatId: string | null;
  onCloseMobile: () => void;
  onNewChat: (projectId?: string | null) => void;
  onSelectChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onOpenProjectModal: (project: ProjectRecord | null) => void;
  onOpenSettings: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  openMobile,
  user,
  agyProfile,
  chats,
  projects,
  activeChatId,
  onCloseMobile,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onOpenProjectModal,
  onOpenSettings,
}) => {
  const [search, setSearch] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const projectById = useMemo(() => {
    const map = new Map<string, ProjectRecord>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, search]);

  const groupedChats = useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const today: ChatRecord[] = [];
    const week: ChatRecord[] = [];
    const older: ChatRecord[] = [];

    for (const c of filteredChats) {
      const age = now - c.lastMessageAt;
      if (age < dayMs) today.push(c);
      else if (age < 7 * dayMs) week.push(c);
      else older.push(c);
    }
    return [
      { label: '今日', items: today },
      { label: '過去7日', items: week },
      { label: 'それ以前', items: older },
    ].filter((g) => g.items.length > 0);
  }, [filteredChats]);

  const commitRename = (chatId: string) => {
    const clean = editTitle.trim();
    setEditingChatId(null);
    if (clean) onRenameChat(chatId, clean);
  };

  return (
    <>
      {openMobile && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`sidebar ${openMobile ? 'open' : ''}`}>
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <div className="brand-mark sm">A</div>
            <span className="brand-title">Antigravity</span>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => {
                onNewChat(null);
                onCloseMobile();
              }}
              title="新しいチャットを開始"
            >
              <PlusIcon size={15} />
              <span>新規</span>
            </button>
            <button
              type="button"
              className="icon-btn mobile-only"
              onClick={onCloseMobile}
              aria-label="サイドバーを閉じる"
            >
              <CloseIcon size={18} />
            </button>
          </div>
        </div>

        <div className="sidebar-search">
          <SearchIcon size={14} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="チャット履歴を検索..."
          />
        </div>

        <div className="sidebar-scroll">
          <div className="sidebar-section">
            <div className="sidebar-section-head">
              <span>プロジェクト</span>
              <button
                type="button"
                className="icon-btn-sm"
                onClick={() => onOpenProjectModal(null)}
                title="プロジェクトを作成"
              >
                <PlusIcon size={14} />
              </button>
            </div>
            {projects.length === 0 ? (
              <button
                type="button"
                className="sidebar-empty-action"
                onClick={() => onOpenProjectModal(null)}
              >
                + 共有指示・資料をまとめる
              </button>
            ) : (
              <div className="project-pills">
                {projects.map((p) => (
                  <div key={p.id} className="project-row">
                    <button
                      type="button"
                      className="project-row-main"
                      onClick={() => {
                        onNewChat(p.id);
                        onCloseMobile();
                      }}
                      title={`"${p.name}" で新規チャットを開始`}
                    >
                      <FolderIcon size={14} />
                      <span className="truncate">{p.name}</span>
                      {p.files.length > 0 && <span className="count-tag">{p.files.length}</span>}
                    </button>
                    <button
                      type="button"
                      className="icon-btn-sm"
                      onClick={() => onOpenProjectModal(p)}
                      title="プロジェクト設定・資料編集"
                    >
                      <SettingsIcon size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-section">
            {groupedChats.length === 0 ? (
              <div className="muted-xs" style={{ padding: '8px 10px' }}>
                {search ? '一致するチャットがありません' : '履歴はまだありません'}
              </div>
            ) : (
              groupedChats.map((group) => (
                <div key={group.label} className="chat-group">
                  <div className="chat-group-label">{group.label}</div>
                  {group.items.map((chat) => {
                    const isActive = chat.id === activeChatId;
                    const runStatus = chat.activeRun?.status;
                    const proj = chat.projectId ? projectById.get(chat.projectId) : null;

                    return (
                      <div
                        key={chat.id}
                        className={`chat-item ${isActive ? 'active' : ''}`}
                      >
                        {editingChatId === chat.id ? (
                          <input
                            type="text"
                            className="chat-rename-input"
                            value={editTitle}
                            autoFocus
                            onChange={(e) => setEditTitle(e.target.value)}
                            onBlur={() => commitRename(chat.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(chat.id);
                              if (e.key === 'Escape') setEditingChatId(null);
                            }}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="chat-item-main"
                              onClick={() => {
                                onSelectChat(chat.id);
                                onCloseMobile();
                              }}
                              onDoubleClick={() => {
                                setEditingChatId(chat.id);
                                setEditTitle(chat.title);
                              }}
                            >
                              {runStatus === 'running' || runStatus === 'queued' ? (
                                <span className="pulse-dot" title="実行中" />
                              ) : runStatus === 'awaiting_permission' ? (
                                <ShieldIcon size={13} className="warn-icon" />
                              ) : null}
                              <div className="chat-item-texts">
                                <div className="chat-item-title truncate">{chat.title}</div>
                                {proj && (
                                  <div className="chat-item-proj truncate">
                                    <FolderIcon size={11} /> {proj.name}
                                  </div>
                                )}
                              </div>
                            </button>
                            <div className="chat-item-actions">
                              <button
                                type="button"
                                className="icon-btn-sm"
                                title="名前を変更"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingChatId(chat.id);
                                  setEditTitle(chat.title);
                                }}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="icon-btn-sm danger"
                                title="削除"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`「${chat.title}」を削除しますか？`)) {
                                    onDeleteChat(chat.id);
                                  }
                                }}
                              >
                                <TrashIcon size={13} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <button type="button" className="user-pill-btn" onClick={onOpenSettings}>
            <div className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
            <div className="user-meta">
              <div className="user-name truncate">{user.displayName}</div>
              <div className="muted-xs truncate">
                <span
                  className={`status-dot ${agyProfile?.authStatus === 'authenticated' ? 'ok' : 'warn'}`}
                />
                {agyProfile?.accountLabel || 'Antigravity連携済'}
              </div>
            </div>
            <SettingsIcon size={16} />
          </button>
        </div>
      </aside>
    </>
  );
};
