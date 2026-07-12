// Service worker for offline use. Bump CACHE_NAME whenever files change
// so returning visitors pick up the new version instead of a stale cache.
const CACHE_NAME = 'vlg-transport-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './data.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for app shell; network falls back to cache for everything
// (fonts included) so the app keeps working with no connection at all.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(resp => {
        if (resp && resp.status === 200 && event.request.url.startsWith(self.location.origin)){
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
