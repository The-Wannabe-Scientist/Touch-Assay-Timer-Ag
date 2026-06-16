// Bug 12: bump this version string on EVERY deployment so existing PWA installs
// pick up updated JS/CSS on the next page load instead of serving stale cached files.
// The activate handler below automatically deletes all caches whose name does not
// match CACHE_NAME, which forces clients to re-fetch all assets after an update.
const CACHE_NAME = "touch-assay-cache-v2.0.0.0.3";

// Ensure paths match your actual directory structure!
// Bug 12: removed "./js/logger.js" — that file was deleted in a prior refactor
// but remained here, causing SW install failures (network error for a 404 response)
// on browsers that enforce addAll() atomicity (Chrome, Firefox).
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/main.js",
  "./js/utils.js",
  "./js/models.js",
  "./js/audio.js",
  "./js/export.js",
  "./js/db.js",
  "./js/timer-worker.js",
  "./js/toast.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];

// 1. INSTALL
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
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
    })
  );
  self.clients.claim();
});

// 3. FETCH: Stale-While-Revalidate Strategy
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // The network fetch that will update the cache in the background
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Cache only successful same-origin responses; skip opaque (cross-origin)
        // responses to avoid inflated storage costs (~7 MB padding per entry)
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);  // Gracefully fall back if offline

      // Return cached response if available, otherwise hit the network
      return cachedResponse || fetchPromise;
    })
  );
});
