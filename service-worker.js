/**
 * @file service-worker.js
 * @description PWA offline cache: stale-while-revalidate for local assets,
 * plus a best-effort CORS cache for the one external CDN dependency (SheetJS).
 */

// Bump this version string on EVERY deployment so existing PWA installs
// pick up updated JS/CSS on the next page load instead of serving stale cached files.
// The activate handler below deletes this app's previous touch-assay-cache-*
// caches, which forces clients to re-fetch all assets after an update. Caches
// with other names belong to other apps on the same origin (e.g. a shared
// github.io domain) and are left alone.
const CACHE_PREFIX = "touch-assay-cache-";
const CACHE_NAME = CACHE_PREFIX + "v2.0.0.3.19";

// Ensure paths match your actual directory structure!
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
  "./icon-512.png",
  // Self-hosted fonts (replaced the Google Fonts CDN — see index.html/styles.css)
  // so typography is available offline instead of silently falling back on
  // first load with no network.
  "./fonts/IBMPlexSans-Variable.woff2",
  "./fonts/IBMPlexSans-Variable-Greek.woff2",
  "./fonts/IBMPlexMono-Regular.woff2",
  "./fonts/IBMPlexMono-Medium.woff2",
  "./fonts/IBMPlexMono-SemiBold.woff2"
];

// Cross-origin CDN URLs are handled separately from local assets.
// cache.addAll() uses no-cors for cross-origin URLs, producing opaque responses
// (status 0) that Chrome rejects. Instead we fetch with mode: 'cors' and
// cache.put() explicitly, wrapped in try/catch so SW install still succeeds
// if the CORS fetch fails (the lib will just be fetched at runtime).
const CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];

// 1. INSTALL
self.addEventListener("install", (event) => {
  // skipWaiting() is chained into waitUntil() so the SW
  // does not activate before caching completes.
  const cachePromise = caches.open(CACHE_NAME).then(async (cache) => {
    // Cache local assets atomically. cache: 'reload' skips the HTTP cache —
    // otherwise a new CACHE_NAME can be filled with the previous deploy's
    // files (GitHub Pages serves max-age=600) while Settings reports the new
    // version.
    await cache.addAll(ASSETS_TO_CACHE.map((url) => new Request(url, { cache: 'reload' })));

    // Cache CDN URLs individually with CORS; failures are non-fatal.
    await Promise.all(
      CDN_URLS.map(async (url) => {
        try {
          const response = await fetch(url, { mode: 'cors' });
          if (response.ok) {
            await cache.put(url, response);
          }
        } catch (e) {
          // CORS fetch failed — the lib will be fetched at runtime instead.
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
          if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) return caches.delete(name);
        })
      );
    }).then(() => self.clients.claim())  // Chain into waitUntil so claim() fires after old caches are purged.
  );
});

// 3. FETCH: Stale-While-Revalidate Strategy
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET') return;
  const isNavigation = event.request.mode === 'navigate';

  event.respondWith((async () => {
    // Look only in this app's cache — the origin's other caches aren't ours.
    const cache = await caches.open(CACHE_NAME);
    // A navigation can carry a query string; it is still the same app shell.
    const cachedResponse = await cache.match(event.request, { ignoreSearch: isNavigation });

    // The network fetch that will update the cache in the background.
    const fetchPromise = fetch(event.request).then((networkResponse) => {
      // Cache only successful same-origin responses; skip opaque (cross-origin)
      // responses to avoid inflated storage costs (~7 MB padding per entry).
      // The one cross-origin dependency (SheetJS from CDN_URLS) is cached during
      // install but never revalidated here — this is intentional. Fonts are now
      // self-hosted same-origin assets (see ASSETS_TO_CACHE) and go through the
      // normal revalidation path below like any other local file.
      if (networkResponse && networkResponse.status === 200) {
        // Clone now: once this response is handed to the page its body is
        // used, and a later clone() throws.
        const copy = networkResponse.clone();
        event.waitUntil(cache.put(event.request, copy).catch(() => {}));
      }
      return networkResponse;
    });

    if (cachedResponse) {
      // Serve the cached copy now; keep the worker alive for the refresh.
      event.waitUntil(fetchPromise.catch(() => {}));
      return cachedResponse;
    }
    try {
      return await fetchPromise;
    } catch {
      // Offline and not cached: a navigation still gets the app shell.
      const shell = isNavigation ? await cache.match('./index.html') : undefined;
      return shell || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
  })());
});
