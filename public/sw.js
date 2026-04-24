/* Minimal service worker. Registers so the app qualifies as a PWA
   and supports "Add to Home Screen" on iOS + Chrome install prompt. */

const CACHE = "archive-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first for everything; fall through to cache only if offline.
// We do NOT want to cache API responses — documents are user data.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // let the network handle API
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
