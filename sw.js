// ═══════════════════════════════════════════════════════════
// Portal Ganadero — Service Worker
// Estrategia:
//   - App shell (HTML + iconos + manifest) → NetworkFirst con fallback a cache
//   - Recursos CDN (Leaflet, etc.) → CacheFirst (no cambian)
//   - Tiles de mapa (ArcGIS/OSM) → CacheFirst (se acumulan al navegar)
//   - Supabase API → NetworkOnly (datos viven en localStorage)
// ═══════════════════════════════════════════════════════════

const APP_VERSION   = 'v1';
const SHELL_CACHE   = `portal-shell-${APP_VERSION}`;
const CDN_CACHE     = `portal-cdn-${APP_VERSION}`;
const TILE_CACHE    = `portal-tiles-${APP_VERSION}`;

// Archivos del app shell que se pre-cachean en install
const APP_SHELL_FILES = [
  './portal_ganadero.html',
  './manifest.json',
  './LP_1.JPG',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './icon-152.png',
  './icon-120.png'
];

// ── INSTALL ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  const validCaches = [SHELL_CACHE, CDN_CACHE, TILE_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => !validCaches.includes(k)).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo interceptamos GET
  if (req.method !== 'GET') return;

  // 1. Tiles de mapa → CacheFirst (se van acumulando al navegar)
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(req, TILE_CACHE, { maxEntries: 2000 }));
    return;
  }

  // 2. Recursos CDN (Leaflet, cdnjs, unpkg) → CacheFirst
  if (isCdnRequest(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 3. Supabase API → NetworkOnly (datos ya están en localStorage)
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) {
    return; // deja pasar sin interceptar
  }

  // 4. App shell (HTML, iconos, manifest) → NetworkFirst con fallback
  if (isAppShell(url)) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 5. Resto → NetworkFirst genérico
  event.respondWith(networkFirst(req, SHELL_CACHE));
});

// ── HELPERS ───────────────────────────────────────────────

function isTileRequest(url) {
  return (
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('openstreetmap.org') ||
    url.hostname.includes('tile.openstreetmap') ||
    url.pathname.includes('/MapServer/tile/') ||
    url.pathname.match(/\/\d+\/\d+\/\d+(\.\w+)?$/) // /{z}/{x}/{y}
  );
}

function isCdnRequest(url) {
  return (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('leafletjs.com')
  );
}

function isAppShell(url) {
  return (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  );
}

// NetworkFirst: intenta red, cae a cache si falla
async function networkFirst(req, cacheName) {
  try {
    const networkRes = await fetch(req);
    if (networkRes.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, networkRes.clone());
    }
    return networkRes;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback: si piden el HTML y no hay cache, devolver el shell cacheado
    if (req.mode === 'navigate') {
      return caches.match('./portal_ganadero.html');
    }
    return new Response('Offline', { status: 503 });
  }
}

// CacheFirst: sirve desde cache, actualiza en segundo plano
async function cacheFirst(req, cacheName, opts = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const networkRes = await fetch(req);
    if (networkRes.ok) {
      // Limitar tamaño del cache de tiles
      if (opts.maxEntries) await evictOldEntries(cacheName, opts.maxEntries);
      cache.put(req, networkRes.clone());
    }
    return networkRes;
  } catch {
    return new Response('Recurso no disponible offline', { status: 503 });
  }
}

// Evict entradas viejas cuando se supera el límite
async function evictOldEntries(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length >= maxEntries) {
    // Borrar el 10% más viejo
    const toDelete = keys.slice(0, Math.floor(maxEntries * 0.1));
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}
