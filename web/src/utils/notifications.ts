import { api } from '../api/client';

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    nav.standalone === true
  );
}

export function isAppleMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;

    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 8000)),
    ]);
    return ready ?? existing ?? null;
  } catch {
    return null;
  }
}

export async function getActivePushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await getSwRegistration();
  if (!reg || !reg.pushManager) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export function formatPushFailureReason(reason?: string): string {
  switch (reason) {
    case 'notification_unsupported':
      return isAppleMobileBrowser() && !isStandalonePwa()
        ? 'iPhone/iPadではSafari共有メニューから「ホーム画面に追加」したアプリとして開く必要があります。'
        : 'このブラウザは通知APIに未対応です（HTTPSまたはlocalhostでアクセスしてください）。';
    case 'permission_not_granted':
      return 'ブラウザの通知権限が許可されていません。';
    case 'push_unsupported':
      return 'この環境はバックグラウンドWeb Push（PushManager / Service Worker）に対応していません。';
    case 'sw_unavailable':
      return 'Service Workerがまだ有効化されていません。ページを再読み込みしてからお試しください。';
    case 'missing_keys':
      return 'ブラウザからPush暗号鍵を取得できませんでした。';
    default:
      return reason ? `Web Push登録エラー: ${reason}` : 'この端末をWeb Pushに登録できませんでした。';
  }
}

export async function getDevicePushSyncStatus(): Promise<{
  hasLocalSubscription: boolean;
  endpoint: string | null;
  registeredOnServer: boolean;
  subscriptionCount: number;
}> {
  const sub = await getActivePushSubscription().catch(() => null);
  const endpoint = sub?.endpoint ?? null;
  try {
    const status = await api.getNotificationStatus(endpoint);
    return {
      hasLocalSubscription: Boolean(sub),
      endpoint,
      registeredOnServer: status.registeredOnServer,
      subscriptionCount: status.subscriptionCount,
    };
  } catch {
    return {
      hasLocalSubscription: Boolean(sub),
      endpoint,
      registeredOnServer: false,
      subscriptionCount: 0,
    };
  }
}

export async function hasDisplayedNotificationTag(tag: string): Promise<boolean> {
  const reg = await getSwRegistration();
  if (!reg || typeof reg.getNotifications !== 'function') return false;
  try {
    const list = await reg.getNotifications({ tag });
    return list.length > 0;
  } catch {
    return false;
  }
}

export async function ensurePushSubscribed(): Promise<{
  subscribed: boolean;
  endpoint?: string;
  subscriptionCount?: number;
  reason?: string;
}> {
  if (!isNotificationSupported()) {
    return { subscribed: false, reason: 'notification_unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { subscribed: false, reason: 'permission_not_granted' };
  }
  if (!isPushSupported()) {
    return { subscribed: false, reason: 'push_unsupported' };
  }

  const reg = await getSwRegistration();
  if (!reg || !reg.active || !reg.pushManager) {
    return { subscribed: false, reason: 'sw_unavailable' };
  }

  try {
    const cfg = await api.getNotificationConfig();
    const vapidKeyBytes = urlBase64ToUint8Array(cfg.vapidPublicKey);

    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey) {
      const currentKey = new Uint8Array(sub.options.applicationServerKey);
      if (!uint8ArraysEqual(currentKey, vapidKeyBytes)) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
    }

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes,
      });
    }

    const json = sub.toJSON();
    const endpoint = sub.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return { subscribed: false, reason: 'missing_keys' };
    }

    const saved = await api.subscribePush({
      endpoint,
      keys: { p256dh, auth },
      userAgent: navigator.userAgent,
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<string | null>('agy:push-endpoint-changed', { detail: endpoint }));
    }

    return {
      subscribed: true,
      endpoint,
      subscriptionCount: saved.subscriptionCount,
    };
  } catch (err) {
    return {
      subscribed: false,
      reason: err instanceof Error ? err.message : 'subscribe_failed',
    };
  }
}

export async function unsubscribePushOnDevice(): Promise<void> {
  const sub = await getActivePushSubscription();
  if (!sub) return;
  try {
    await api.unsubscribePush(sub.endpoint);
  } catch {
    // ignore backend error if session already gone
  }
  await sub.unsubscribe().catch(() => false);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<string | null>('agy:push-endpoint-changed', { detail: null }));
  }
}

export async function showBrowserNotification(params: {
  title: string;
  body: string;
  tag: string;
  chatId?: string;
  vibrate?: number[];
}): Promise<boolean> {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const url = params.chatId ? `/?chatId=${encodeURIComponent(params.chatId)}` : '/';
  const reg = await getSwRegistration();
  if (reg && typeof reg.showNotification === 'function') {
    try {
      const options: NotificationOptions & { vibrate?: number[] } = {
        body: params.body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: params.tag,
        data: { chatId: params.chatId ?? '', url },
      };
      if (params.vibrate && params.vibrate.length > 0) {
        options.vibrate = params.vibrate;
      }
      await reg.showNotification(params.title, options);
      return true;
    } catch {
      // Fall back to direct Notification constructor below
    }
  }

  try {
    const n = new Notification(params.title, {
      body: params.body,
      icon: '/icon.svg',
      tag: params.tag,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      if (params.chatId) {
        window.dispatchEvent(new CustomEvent('agy:open-chat', { detail: { chatId: params.chatId } }));
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
