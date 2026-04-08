
const CACHE = 'invoice-pdf-v13';
const ASSETS = [
  './index.html',
  './manifest.json',
  './mcnichol-app/icons/icon-192.png',
  './mcnichol-app/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return Promise.allSettled(ASSETS.map(a => cache.add(a).catch(() => {})));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return response;
      }).catch(() => cached);
    })
  );
});

self.addEventListener('notificationclick', e => {
  const action = e.action;
  const data = e.notification.data || {};
  e.notification.close();

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      if (cls.length > 0) {
        const client = cls[0];
        return client.focus().then(c => {
          if (action === 'adjust') {
            c.postMessage({ type: 'adjust-time', startTime: data.startTime });
          } else if (action === 'adjust-stop') {
            c.postMessage({ type: 'adjust-stop-time', stopTime: data.stopTime });
          }
          return c;
        });
      }
      return clients.openWindow('./');
    })
  );
});
