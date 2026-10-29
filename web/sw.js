const CACHE_NAME = "fairpay-v7";
const PRECACHE = [
  // Merchant assets
  "./merchant.js",
  "./tailwind.js",
  "./manifest.webmanifest",
  "./icons/icon-orange.svg",
  "./icons/icon-orange-192.png",
  "./icons/icon-orange-512.png",
  // Donde assets
  "./fonts/archivo.css",
  "./mapa-unq.png",
  "./screenshots/productor-placeholder.svg",
];

const NETWORK_TIMEOUT_MS = 200;

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
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never cache API, payment routes, or HTML pages
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/get-money") ||
    request.destination === "document" ||
    url.pathname.endsWith(".html")
  ) {
    return;
  }

  event.respondWith(networkFirstWithTimeout(request));
});

async function networkFirstWithTimeout(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  let networkResolved = false;

  const network = fetch(request)
    .then(async (response) => {
      networkResolved = true;
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch((error) => {
      networkResolved = true;
      console.warn("[SW] network fetch failed", request.url, error);
      return cached || error;
    });

  if (!cached) {
    return network;
  }

  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (!networkResolved) {
        resolve(cached);
      }
    }, NETWORK_TIMEOUT_MS);
  });

  return Promise.race([network, timeout]).then((result) => {
    if (result instanceof Response) {
      return result;
    }
    return cached;
  });
}

self.addEventListener("push", (event) => {
  let title = "FairPay";
  let body = "Nueva actividad / New activity";
  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      if (payload.message) body = payload.message;
    } catch (e) {
      // malformed payload: keep generic bilingual-safe text
    }
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./icons/icon-orange-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        return clients.openWindow("./merchant.html");
      })
  );
});
