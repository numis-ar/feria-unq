const CACHE_NAME = "feria-unq-donde-assets-v2";
const PRECACHE = [
  "./fonts/archivo.css",
  "./mapa-unq.png",
  "./screenshots/productor-placeholder.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Nunca cachear donde.html, productores.json ni las páginas de share:
  // así los cambios de contenido se ven al recargar.
  if (
    url.pathname.endsWith("/donde.html") ||
    url.pathname.endsWith("/productores.json") ||
    url.pathname.startsWith("/share/")
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first para assets estáticos.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      });
    })
  );
});
