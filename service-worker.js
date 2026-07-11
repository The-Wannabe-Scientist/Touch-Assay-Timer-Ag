// Bump this version string on EVERY deployment so existing PWA installs
// Pick up updated JS/CSS on the next page load instead of serving stale cached files.
// The activate handler below automatically deletes all caches whose name does not
// Match CACHE_NAME, which forces clients to re-fetch all assets after an update.
const CACHE_NAME = "touch-assay-cache-v2.0.0.3.7";

// Ensure paths match your actual directory structure!
// Removed "./js/logger.js" — that file was deleted in a prior refactor
// But remained here, causing SW install failures (network error for a 404 response)
// On browsers that enforce addAll() atomicity (Chrome, Firefox).
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/main.js",
  "./js/haptic-armband.js",
  "./js/utils.js",
  "./js/models.js",
  "./js/audio.js",
  "./js/export.js",
  "./js/db.js",
  "./js/timer-worker.js",
  "./js/toast.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Cross-origin CDN URL separated from local assets.
// Cache.addAll() uses no-cors for cross-origin URLs, producing opaque responses
// (status 0) that Chrome rejects. Instead we fetch with mode: 'cors' and
// Cache.put() explicitly, wrapped in try/catch so SW install still succeeds
// If the CORS fetch fails (the lib will just be fetched at runtime).
const CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];

// 1. INSTALL
self.addEventListener("install", (event) => {
  // SkipWaiting() is now chained into waitUntil() so the SW
  // Does not activate before caching completes.
  const cachePromise = caches.open(CACHE_NAME).then(async (cache) => {
    // Cache local assets atomically
    await cache.addAll(ASSETS_TO_CACHE);

    // Cache CDN URLs individually with CORS; failures are non-fatal
    await Promise.all(
      CDN_URLS.map(async (url) => {
        try {
          const response = await fetch(url, { mode: 'cors' });
          if (response.ok) {
            await cache.put(url, response);
          }
        } catch (e) {
          // CORS fetch failed — the lib will be fetched at runtime instead
          console.warn(`[SW] Failed to cache CDN URL: ${url}`, e);
        }
      })
    );
  });

  event.waitUntil(cachePromise.then(() => self.skipWaiting()));
});

// 2. ACTIVATE
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      );
    }).then(() => self.clients.claim())  // H6: chain into waitUntil so claim() fires after old caches are purged
  );
});

// 3. FETCH: Stale-While-Revalidate Strategy
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // The network fetch that will update the cache in the background
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Cache only successful same-origin responses; skip opaque (cross-origin)
        // Responses to avoid inflated storage costs (~7 MB padding per entry)
        // NOTE: Cross-origin resources (e.g. Google Fonts) are cached during install
        // But never revalidated here — this is intentional. Fonts are immutable CDN
        // Assets and permanent caching is the accepted trade-off. (C5)
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));  // Return 503 when both cache miss and network fail

      // Return cached response if available, otherwise hit the network
      return cachedResponse || fetchPromise;
    })
  );
});
