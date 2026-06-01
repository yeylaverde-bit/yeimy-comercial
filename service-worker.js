/* Service Worker simple para Yeimy Comercial.
 * Estrategia: network-first para HTML/JS/CSS (siempre datos frescos);
 * cache-first para íconos y manifest (cambian poco).
 * NO cachear /api/* (cada llamada debe llegar viva al servidor).
 */

const CACHE_VERSION = "yc-v1";
const CACHE_NAME = `yeimy-comercial-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Nunca cachear endpoints de API
  if (url.pathname.startsWith("/api/")) return;

  // Solo GET
  if (event.request.method !== "GET") return;

  // Cache-first para íconos y logo
  if (/\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        return resp;
      }).catch(() => hit))
    );
    return;
  }

  // Network-first para HTML/JS/CSS (con fallback a cache si no hay red)
  if (/\.(html|js|css)$/.test(url.pathname) || url.pathname === "/" || url.pathname === "/login.html") {
    event.respondWith(
      fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(event.request))
    );
  }
});
