// Service worker — Mountain Portal offline support.
// Three caches: shell (precached), tiles (cache-first immutable), api (network-first).

const SHELL_CACHE = 'shell-v1';
const TILES_CACHE = 'tiles-v1';
const API_CACHE = 'api-v1';
const KNOWN_CACHES = new Set([SHELL_CACHE, TILES_CACHE, API_CACHE]);

const SHELL_URLS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/main.js',
  '/js/map.js',
  '/js/search.js',
  '/js/ui.js',
  '/js/icons.js',
  '/js/elevation.js',
  '/js/offline.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.js',
  'https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.css',
];

const TILE_HOSTS = /^https:\/\/[abc]\.tile\.opentopomap\.org\//;
const MAPBOX_HOSTS = /^https:\/\/api\.mapbox\.com\/(styles\/v1|fonts\/v1|v4|mapbox-gl-js)\//;
const API_PREFETCH = /\/api\/(offline\/bundle|trails|pois|ferrata)(\?|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails atomically — fall back to per-URL add so one bad CDN URL does not abort install
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('SW shell precache miss', url, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => (KNOWN_CACHES.has(key) ? null : caches.delete(key)))
      )
    ).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return TILE_HOSTS.test(url) || MAPBOX_HOSTS.test(url);
}

function isApiPrefetch(url) {
  return API_PREFETCH.test(url);
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = request.url;

  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILES_CACHE));
    return;
  }

  if (isApiPrefetch(url)) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Shell assets — cache-first, falling back to network for runtime updates.
  const accept = request.headers.get('accept') || '';
  if (request.destination === 'document' || accept.includes('text/html')) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'manifest'
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Everything else (search, ai/research, telemetry…) — pass-through.
});
