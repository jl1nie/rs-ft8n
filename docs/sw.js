// Service Worker for WebFT8 PWA — offline cache
const CACHE_NAME = 'webft8-v0.4.11-uv0.2.8-58c2ab88';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './qso.js',
  './waterfall.js',
  './qso-log.js',
  './cat.js',
  './ble-transport.js',
  './ft8-period.js',
  './audio-capture.js',
  './audio-output.js',
  './audio-processor.js',
  './decode-worker.js',
  './ft8_web.js',
  './ft8_web_bg.wasm',
  './manifest.json',
];

// Install: cache all assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first, fallback to cache
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Update cache with fresh response
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
