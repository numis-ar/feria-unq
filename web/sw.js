const CACHE_NAME = "fairpay-v4";
const PRECACHE = [
  "./merchant.html",
  "./merchant.js",
  "./tailwind.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API polling or payment routes
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/get-money")) return;

  event.respondWith(
    (async () => {
      // Pages: network-first so updates reach installed apps, cache fallback when offline
      if (event.request.mode === "navigate") {
        try {
          const fresh = await fetch(event.request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          throw e;
        }
      }
      // Static assets: cache-first
      const cached = await caches.match(event.request);
      return cached || fetch(event.request);
    })()
  );
});

self.addEventListener("push", (event) => {
  let title = "FairPay";
  let body = "Nueva actividad / New activity";
  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      if (payload.message) body = payload.message;
    } catch (e) {
      // malformed payload: keep the generic bilingual-safe text
    }
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow("./merchant.html");
    })
  );
});
