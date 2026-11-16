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
    if (existing) {
      if (existing.active) return existing;
    }
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2000)),
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
}

export async function showBrowserNotification(params: {
  title: string;
  body: string;
  tag: string;
  chatId?: string;
}): Promise<boolean> {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const url = params.chatId ? `/?chatId=${encodeURIComponent(params.chatId)}` : '/';
  const reg = await getSwRegistration();
  if (reg && typeof reg.showNotification === 'function') {
    try {
      await reg.showNotification(params.title, {
        body: params.body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: params.tag,
        data: { chatId: params.chatId ?? '', url },
      });
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
