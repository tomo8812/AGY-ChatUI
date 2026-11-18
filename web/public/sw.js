const CACHE_NAME = 'antigravity-chat-shell-v5';
const SHELL_ASSETS = ['/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      try {
        data = { body: event.data.text() };
      } catch {
        data = {};
      }
    }
  }

  const title =
    typeof data.title === 'string' && data.title ? data.title : 'Antigravity Chat';
  const body =
    typeof data.body === 'string' && data.body ? data.body : '応答が完了しました。';
  const tag =
    typeof data.tag === 'string' && data.tag ? data.tag : 'antigravity-response';
  const chatId = typeof data.chatId === 'string' ? data.chatId : '';
  const url =
    typeof data.url === 'string' && data.url
      ? data.url
      : chatId
        ? `/?chatId=${encodeURIComponent(chatId)}`
        : '/';

  const showPromise = self.registration
    .showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag,
      renotify: true,
      ...(Array.isArray(data.vibrate) ? { vibrate: data.vibrate } : {}),
      data: { chatId, url },
    })
    .catch(() =>
      self.registration.showNotification(title, {
        body,
        tag,
        data: { chatId, url },
      })
    );

  const notifyClientsPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      for (const c of clientList) {
        c.postMessage({ type: 'PUSH_RECEIVED', tag, chatId });
      }
    })
    .catch(() => {});

  event.waitUntil(Promise.all([showPromise, notifyClientsPromise]));
});

async function getCsrfToken() {
  try {
    if (self.cookieStore && typeof self.cookieStore.get === 'function') {
      const cookie = await self.cookieStore.get('agy_chat_csrf');
      if (cookie && typeof cookie.value === 'string' && cookie.value) {
        return decodeURIComponent(cookie.value);
      }
    }
  } catch {
    // Ignore if CookieStore API is unavailable or restricted
  }
  return '';
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cfgRes = await fetch('/api/notifications/config', { credentials: 'include' });
        if (!cfgRes.ok) return;
        const cfg = await cfgRes.json();
        if (!cfg || typeof cfg.vapidPublicKey !== 'string' || !cfg.vapidPublicKey) return;

        const padding = '='.repeat((4 - (cfg.vapidPublicKey.length % 4)) % 4);
        const base64 = (cfg.vapidPublicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const applicationServerKey = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
          applicationServerKey[i] = raw.charCodeAt(i);
        }

        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const json = sub.toJSON();
        if (!json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) return;

        const csrfToken = await getCsrfToken();
        if (!csrfToken) {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const c of clientList) {
            c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
          }
          return;
        }

        await fetch('/api/notifications/subscribe', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            userAgent: self.navigator ? self.navigator.userAgent : '',
          }),
        });
      } catch {
        // Active tabs also re-sync via ensurePushSubscribed()
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const chatId = typeof data.chatId === 'string' ? data.chatId : '';
  const targetUrl = typeof data.url === 'string' && data.url ? data.url : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            if (chatId) {
              client.postMessage({ type: 'OPEN_CHAT', chatId });
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});

// NEVER cache `/api/*`, WebSocket upgrades, auth tokens, or private artifacts!
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Always network-first (no-store) for HTML navigations so deployed updates load immediately
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(new Request(req, { cache: 'no-store' }))
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('/', clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic' && url.pathname.startsWith('/assets/')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
