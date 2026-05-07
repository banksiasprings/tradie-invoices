
const CACHE = 'invoice-pdf-v73';
// Resources that must survive a fresh SW install so the app can boot offline.
// Anything fetched at runtime gets cached by the fetch handler too, but that
// only helps if the user happens to be online when it's first requested.
// Pre-caching these means the very first offline launch after a SW update
// still has the app shell, fonts, Firebase SDK, and Leaflet available.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './tradie-app/icons/icon-192.png',
  './tradie-app/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// URLs we must never cache: auth/data calls and OTA manifest must always
// be fresh. Returning without calling respondWith() lets the browser handle
// the request as if the SW weren't installed.
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebaseapp.com',
  'firebaseinstallations.googleapis.com',
  '/updates/latest.json',
  '/updates/bundle.zip'
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
  const req = e.request;
  // Mutating requests must never go through the cache.
  if (req.method !== 'GET') return;
  // Firestore, auth, and OTA URLs always hit the network — caching them
  // either serves stale data across users or pins old OTA versions forever.
  if (NEVER_CACHE.some(p => req.url.includes(p))) return;
  // Cache-first for everything else (app shell, fonts, icons).
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached)
    )
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
