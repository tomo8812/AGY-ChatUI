import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AppDatabase } from '../db/database.js';
import type { SyncEventEnvelope } from '../types.js';

interface SocketRegistration {
  userId: string;
  sessionIdHash: string;
  clientId: string;
  ws: WebSocket;
}

export class SyncHub {
  private readonly connections = new Map<string, Set<SocketRegistration>>();

  constructor(private readonly db: AppDatabase) {}

  registerConnection(params: {
    userId: string;
    sessionIdHash: string;
    clientId: string;
    ws: WebSocket;
    sinceSeq?: number;
  }): () => void {
    const reg: SocketRegistration = {
      userId: params.userId,
      sessionIdHash: params.sessionIdHash,
      clientId: params.clientId,
      ws: params.ws,
    };

    let set = this.connections.get(params.userId);
    if (!set) {
      set = new Set();
      this.connections.set(params.userId, set);
    }
    set.add(reg);

    // Send catchup or full-resync instruction scoped strictly to this authenticated userId
    this.sendReplayHello(reg, params.sinceSeq ?? 0);

    return () => {
      const current = this.connections.get(params.userId);
      if (current) {
        current.delete(reg);
        if (current.size === 0) {
          this.connections.delete(params.userId);
        }
      }
    };
  }

  private sendReplayHello(reg: SocketRegistration, sinceSeq: number): void {
    const { events, truncated, latestSeq } = this.db.getSyncEventsSince(reg.userId, sinceSeq);
    this.safeSend(reg.ws, {
      kind: 'hello',
      userId: reg.userId,
      clientId: reg.clientId,
      latestSeq,
      resyncRequired: truncated,
      events: truncated ? [] : events,
    });
  }

  emitDurable(params: {
    userId: string;
    type: string;
    chatId?: string | null;
    projectId?: string | null;
    runId?: string | null;
    payload: unknown;
  }): SyncEventEnvelope {
    const envelope = this.db.appendSyncEvent({
      userId: params.userId,
      eventId: crypto.randomUUID(),
      type: params.type,
      chatId: params.chatId,
      projectId: params.projectId,
      runId: params.runId,
      payload: params.payload,
    });

    this.broadcastToUser(params.userId, {
      kind: 'event',
      event: envelope,
    });
    return envelope;
  }

  emitEphemeral(params: {
    userId: string;
    type: string;
    chatId?: string | null;
    runId?: string | null;
    payload: unknown;
  }): void {
    this.broadcastToUser(params.userId, {
      kind: 'ephemeral',
      event: {
        eventId: crypto.randomUUID(),
        userId: params.userId,
        type: params.type,
        chatId: params.chatId ?? null,
        runId: params.runId ?? null,
        payload: params.payload,
        createdAt: Date.now(),
      },
    });
  }

  disconnectSession(userId: string, sessionIdHash: string, reason = 'logged_out'): void {
    const set = this.connections.get(userId);
    if (!set) return;
    for (const reg of [...set]) {
      if (reg.sessionIdHash === sessionIdHash) {
        try {
          reg.ws.close(4001, reason);
        } catch {
          // ignore
        }
        set.delete(reg);
      }
    }
    if (set.size === 0) this.connections.delete(userId);
  }

  disconnectAllForUser(userId: string, reason = 'session_revoked'): void {
    const set = this.connections.get(userId);
    if (!set) return;
    for (const reg of [...set]) {
      try {
        reg.ws.close(4001, reason);
      } catch {
        // ignore
      }
    }
    this.connections.delete(userId);
  }

  getConnectedClientCount(userId: string): number {
    return this.connections.get(userId)?.size ?? 0;
  }

  private broadcastToUser(userId: string, message: unknown): void {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return;
    const json = JSON.stringify(message);
    for (const reg of set) {
      if (reg.userId !== userId) continue; // Defensive boundary check
      if (reg.ws.readyState === 1) {
        try {
          reg.ws.send(json);
        } catch {
          // cleaned up on close
        }
      }
    }
  }

  private safeSend(ws: WebSocket, message: unknown): void {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // ignore
      }
    }
  }
}
