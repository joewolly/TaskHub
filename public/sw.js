const CACHE = 'taskhub-mobile-v9';
const ASSETS = ['/app-shell.html', '/capture.html', '/app.js', '/planning.js', '/capture.js', '/paste-capture.js', '/paste-tasks.js', '/sw-update.js', '/draft-store.js', '/offline.js', '/settings.js', '/mobile.js', '/photos.js', '/styles.css', '/mobile.css', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE') self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (/^taskhub-(capture|mobile)-/.test(key) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname === '/capture.html' ? '/capture.html' : '/app-shell.html');
    }));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(url.pathname) || fetch(event.request)));
  }
});
self.addEventListener('push', event => event.waitUntil((async () => {
  let payload;
  try { payload = event.data.json(); } catch { payload = {}; }
  const url = typeof payload.url === 'string' && /^\/#\//.test(payload.url) ? payload.url : '/#/';
  await self.registration.showNotification(payload.title || 'Task Hub', {
    body: payload.body || 'Open Task Hub to check your tasks.', tag: payload.tag || 'taskhub',
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url },
  });
  if (Number.isSafeInteger(payload.badge) && payload.badge >= 0) {
    try { if (payload.badge) await self.navigator.setAppBadge?.(payload.badge); else await self.navigator.clearAppBadge?.(); } catch {}
  }
})()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || '/#/', self.location.origin);
    if (url.origin !== self.location.origin) return;
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin === url.origin) { await client.navigate(url.href); await client.focus(); return; }
    }
    await self.clients.openWindow(url.href);
  })());
});
