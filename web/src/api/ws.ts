import type { SyncEventEnvelope, WsIncomingMessage } from '../types';
import { UserSequenceBuffer } from './userSequence';

export type WsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export function getTabClientId(): string {
  try {
    const existing = sessionStorage.getItem('agy_chat_client_id');
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('agy_chat_client_id', generated);
    return generated;
  } catch {
    return `tab-${Date.now()}`;
  }
}

export interface SyncSocketCallbacks {
  onStatusChange: (status: WsConnectionStatus) => void;
  onHello: (msg: Extract<WsIncomingMessage, { kind: 'hello' }>) => void;
  onDurableEvent: (event: SyncEventEnvelope, replay: boolean) => void;
  onResync: (signal: AbortSignal) => Promise<{ snapshotUserSeq: number; latestSeq: number }>;
  onEphemeralEvent: (event: Extract<WsIncomingMessage, { kind: 'ephemeral' }>['event']) => void;
  onAuthLost: (reason: string) => void;
}

export class SyncSocketClient {
  private ws: WebSocket | null = null;
  private closedExplicitly = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private readonly sequence = new UserSequenceBuffer<SyncEventEnvelope>();
  private latestUserSeq = 0;
  private snapshotController: AbortController | null = null;
  private snapshotRetry: number | null = null;
  private legacyLastSeq = 0;
  private legacyProtocol = false;
  private readonly clientId = getTabClientId();
  private pushEndpoint: string | null = null;

  constructor(private readonly callbacks: SyncSocketCallbacks) {}

  getClientId(): string {
    return this.clientId;
  }

  getLastSeq(): number {
    return this.legacyProtocol ? this.legacyLastSeq : this.sequence.lastSeq;
  }

  setPushEndpoint(endpoint: string | null): void {
    const normalized = endpoint ? endpoint.trim() : null;
    if (this.pushEndpoint === normalized && this.ws?.readyState !== WebSocket.OPEN) {
      this.pushEndpoint = normalized;
      return;
    }
    this.pushEndpoint = normalized;
    this.sendPresence();
  }

  private sendPresence(visible = document.visibilityState === 'visible'): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          kind: 'presence',
          visible,
          pushEndpoint: this.pushEndpoint,
        })
      );
    } catch {
      // handled on close
    }
  }

  start(): void {
    this.closedExplicitly = false;
    this.connect();

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('online', this.handleNetworkOnline);
    window.addEventListener('pageshow', this.handlePageShow);
    window.addEventListener('pagehide', this.handlePageHide);
  }

  stop(): void {
    this.closedExplicitly = true;
    this.snapshotController?.abort();
    this.snapshotController = null;
    if (this.snapshotRetry !== null) window.clearTimeout(this.snapshotRetry);
    this.snapshotRetry = null;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('online', this.handleNetworkOnline);
    window.removeEventListener('pageshow', this.handlePageShow);
    window.removeEventListener('pagehide', this.handlePageHide);
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client_stop');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.callbacks.onStatusChange('disconnected');
  }

  reconnectNow(): void {
    if (this.closedExplicitly) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({ kind: 'ping', visible: document.visibilityState === 'visible' })
        );
        return;
      } catch {
        // fall through to reopen
      }
    }
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connect();
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.reconnectNow();
      this.sendPresence(true);
    } else {
      this.sendPresence(false);
    }
  };

  private handleNetworkOnline = (): void => {
    this.reconnectNow();
  };

  private handlePageShow = (): void => {
    this.reconnectNow();
    this.sendPresence();
  };

  private handlePageHide = (): void => {
    this.sendPresence(false);
  };

  private connect(): void {
    if (this.closedExplicitly) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.callbacks.onStatusChange(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cursor = this.legacyProtocol
      ? `sinceSeq=${this.legacyLastSeq}`
      : `sinceUserSeq=${this.sequence.contiguousUserSeq}`;
    const wsUrl = `${proto}//${window.location.host}/api/ws?${cursor}&clientId=${encodeURIComponent(this.clientId)}`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.callbacks.onStatusChange('connected');
      this.sendPresence();
      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(
              JSON.stringify({ kind: 'ping', visible: document.visibilityState === 'visible' })
            );
          } catch {
            // handled on close
          }
        }
      }, 20_000);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.closedExplicitly) return;
      try {
        const msg = JSON.parse(String(ev.data)) as WsIncomingMessage;
        if (msg.kind === 'hello') {
          this.legacyProtocol = !Number.isSafeInteger(msg.latestUserSeq);
          this.callbacks.onHello(msg);
          if (this.legacyProtocol) {
            for (const item of msg.events) {
              if (item.seq <= this.legacyLastSeq) continue;
              this.callbacks.onDurableEvent(item, true);
              this.legacyLastSeq = item.seq;
            }
            if (msg.resyncRequired) this.requestSnapshot();
            return;
          }
          this.latestUserSeq = Math.max(this.latestUserSeq, msg.latestUserSeq);
          if (msg.resyncRequired) this.sequence.beginSnapshot();
          for (const item of msg.events) this.sequence.offer(item);
          if (msg.resyncRequired) this.requestSnapshot();
          this.sequence.drain(item => this.callbacks.onDurableEvent(item, true));
          this.recoverGap();
        } else if (msg.kind === 'event') {
          if (this.legacyProtocol) {
            if (msg.event.seq <= this.legacyLastSeq) return;
            this.callbacks.onDurableEvent(msg.event, false);
            this.legacyLastSeq = msg.event.seq;
            return;
          }
          this.sequence.offer(msg.event);
          this.latestUserSeq = Math.max(this.latestUserSeq, msg.event.userSeq);
          this.sequence.drain(item => this.callbacks.onDurableEvent(item, false));
          this.recoverGap();
        } else if (msg.kind === 'pong' && Number.isSafeInteger(msg.latestUserSeq)) {
          this.latestUserSeq = Math.max(this.latestUserSeq, msg.latestUserSeq);
          this.recoverGap();
        } else if (msg.kind === 'ephemeral') {
          this.callbacks.onEphemeralEvent(msg.event);
        }
      } catch {
        // Do not acknowledge a failed durable apply. Reconnect from the last applied cursor.
        this.ws?.close(4000, 'sync_replay');
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();

      if (this.closedExplicitly) {
        this.callbacks.onStatusChange('disconnected');
        return;
      }

      if (ev.code === 4401 || ev.code === 4001) {
        this.callbacks.onStatusChange('disconnected');
        this.callbacks.onAuthLost(ev.reason || 'session_revoked');
        return;
      }

      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow cleanly
    };
  }

  private recoverGap(): void {
    if (!this.legacyProtocol && this.sequence.needsReplay(this.latestUserSeq) &&
        this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(4000, 'sync_gap');
    }
  }

  private requestSnapshot(): void {
    if (this.closedExplicitly || this.snapshotController || this.snapshotRetry !== null) return;
    this.sequence.beginSnapshot();
    const controller = new AbortController();
    this.snapshotController = controller;
    void this.callbacks.onResync(controller.signal).then(snapshot => {
      if (controller.signal.aborted || this.snapshotController !== controller) return;
      this.sequence.completeSnapshot(snapshot.snapshotUserSeq, snapshot.latestSeq);
      this.legacyLastSeq = snapshot.latestSeq;
      this.sequence.drain(item => this.callbacks.onDurableEvent(item, true));
      this.recoverGap();
    }).catch(() => {
      if (controller.signal.aborted || this.closedExplicitly) return;
      this.snapshotRetry = window.setTimeout(() => {
        this.snapshotRetry = null;
        this.requestSnapshot();
      }, 1000);
    }).finally(() => {
      if (this.snapshotController === controller) this.snapshotController = null;
    });
  }

  private scheduleReconnect(): void {
    if (this.closedExplicitly) return;
    this.callbacks.onStatusChange('reconnecting');
    const delayMs = Math.min(15_000, 500 * Math.pow(1.6, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, delayMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
