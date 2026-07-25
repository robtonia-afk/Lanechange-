/**
 * Offline shell. Bump CACHE when any shell file changes, otherwise the phone
 * keeps serving the old copy.
 */
const CACHE = 'lanechange-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './nav.js',
  './openings.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Geocoding is live-only; never serve a stale search from cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch has the newest build.
        event.waitUntil(
          fetch(request)
            .then((fresh) => fresh.ok && caches.open(CACHE).then((c) => c.put(request, fresh.clone())))
            .catch(() => {}),
        );
        return hit;
      }
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
