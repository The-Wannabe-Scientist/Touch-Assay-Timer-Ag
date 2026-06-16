const CACHE_NAME = "touch-assay-cache-v1.1.6.1.3.1";

// Ensure paths match your actual directory structure!
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
  "./js/logger.js",
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
        // Cache successful and opaque (cross-origin) responses
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      });

      // Return cached response if available, otherwise hit the network
      return cachedResponse || fetchPromise;
    })
  );
});
