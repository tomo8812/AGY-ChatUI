import type { SyncEventEnvelope, WsIncomingMessage } from '../types';

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
  onDurableEvent: (event: SyncEventEnvelope) => void;
  onEphemeralEvent: (event: Extract<WsIncomingMessage, { kind: 'ephemeral' }>['event']) => void;
  onAuthLost: (reason: string) => void;
}

export class SyncSocketClient {
  private ws: WebSocket | null = null;
  private closedExplicitly = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastSeq = 0;
  private readonly clientId = getTabClientId();

  constructor(private readonly callbacks: SyncSocketCallbacks) {}

  getClientId(): string {
    return this.clientId;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  start(): void {
    this.closedExplicitly = false;
    this.connect();

    document.addEventListener('visibilitychange', this.handleVisibilityWake);
    window.addEventListener('online', this.handleNetworkOnline);
    window.addEventListener('pageshow', this.handlePageShow);
  }

  stop(): void {
    this.closedExplicitly = true;
    document.removeEventListener('visibilitychange', this.handleVisibilityWake);
    window.removeEventListener('online', this.handleNetworkOnline);
    window.removeEventListener('pageshow', this.handlePageShow);
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
        this.ws.send(JSON.stringify({ kind: 'ping' }));
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

  private handleVisibilityWake = (): void => {
    if (document.visibilityState === 'visible') {
      this.reconnectNow();
    }
  };

  private handleNetworkOnline = (): void => {
    this.reconnectNow();
  };

  private handlePageShow = (): void => {
    this.reconnectNow();
  };

  private connect(): void {
    if (this.closedExplicitly) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.callbacks.onStatusChange(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/ws?sinceSeq=${this.lastSeq}&clientId=${encodeURIComponent(
      this.clientId
    )}`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.callbacks.onStatusChange('connected');
      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(JSON.stringify({ kind: 'ping' }));
          } catch {
            // handled on close
          }
        }
      }, 20_000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsIncomingMessage;
        if (msg.kind === 'hello') {
          this.lastSeq = Math.max(this.lastSeq, msg.latestSeq || 0);
          for (const item of msg.events) {
            if (item.seq > this.lastSeq) this.lastSeq = item.seq;
          }
          this.callbacks.onHello(msg);
        } else if (msg.kind === 'event') {
          if (msg.event.seq > this.lastSeq) {
            this.lastSeq = msg.event.seq;
          }
          this.callbacks.onDurableEvent(msg.event);
        } else if (msg.kind === 'ephemeral') {
          this.callbacks.onEphemeralEvent(msg.event);
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
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
