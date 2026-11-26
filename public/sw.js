// Service worker: shows the app's Web Push notifications (server/push.ts) and opens the document on tap.
// No caching: the app always loads fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'אוסף החשבוניות', {
    body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png',
    dir: 'rtl', lang: 'he', data: { url: d.url || '/attention' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/attention', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      try { await w.navigate(url); } catch { /* not controlled yet: focus is enough */ }
      return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
