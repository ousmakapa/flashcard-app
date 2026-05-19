// Ankur — Service Worker
// Caches all app shell files on install so the app works fully offline.
// Uses a cache-first strategy: serve from cache, fall back to network.

const CACHE_NAME = 'ankur-v5-shell-r19';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './scheduler.js',
  './importer.js',
  './apkg_reader.js',
  './stats.js',
  './ui.js',
  './app.js',
  './pdf_importer.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
