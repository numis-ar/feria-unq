# Service Worker — Decisiones de diseño

> Estado: implementado en `web/sw.js`. `web/sw-donde.js` fue eliminado.

## Objetivo

Resolver el problema de no poder saber si un fix del servidor ya impactó en todos los clientes, sin renunciar por completo al cache de assets.

## Decisiones

### 1. Un único Service Worker para todas las páginas

- Antes había dos SW: `web/sw.js` (merchant) y `web/sw-donde.js` (donde).
- Ahora `web/sw.js` se registra desde `web/merchant.html` y `web/donde.html`.
- El scope por defecto (`/web/`) cubre ambas páginas porque el SW vive en `web/sw.js`.

### 2. Estrategia network-first con timeout de 200 ms

- Para cada asset cacheable se inicia un fetch a la red.
- Si la red responde antes de 200 ms, se devuelve esa respuesta fresca y se actualiza el cache.
- Si la red tarda más de 200 ms, se devuelve el cache (si existe) y el fetch sigue corriendo en background para actualizar el cache.
- Si no hay cache y la red falla, falla la request.

Razón: prioriza ver la versión del servidor cuando hay red decente, pero no castiga la percepción de velocidad en redes lentas.

### 3. HTML nunca se cachea

- Se ignoran requests cuyo `request.destination === "document"` o cuya URL termine en `.html`.
- Esto garantiza que siempre se sirva la versión más reciente del markup y que un cambio en el servidor se refleje en la próxima carga de página.

### 4. API, pagos y rutas dinámicas no se cachean

- Se ignoran `/api/*`, `/get-money`, y cualquier request no-GET o de otro origen.
- `productores.json` y `/share/*` tampoco se cachean (se mantiene el comportamiento anterior de `sw-donde.js`).

### 5. `updateViaCache: "none"`

- Ambos registros (`merchant.html` y `donde.html`) usan `navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })`.
- Esto evita que el navegador use el cache HTTP al buscar actualizaciones del propio script del SW.

### 6. Cambio de `CACHE_NAME` limpia el cache viejo

- La constante `CACHE_NAME` se usa como namespace de la cache.
- En el evento `activate` se borran todas las caches cuya key sea distinta a `CACHE_NAME`.
- Cuando se cambia `CACHE_NAME` (por ejemplo, al bump de `fairpay-v6` a `fairpay-v7`), los clientes descartan el cache anterior y precachean los assets nuevos.

### 7. Precache mínimo

Se precachean solo assets estáticos que no cambian frecuentemente:

- Merchant: `merchant.js`, `tailwind.js`, `manifest.webmanifest`, iconos.
- Donde: `fonts/archivo.css`, `mapa-unq.png`, `screenshots/productor-placeholder.svg`.

No se precachean páginas HTML ni datos dinámicos.

### 8. Push y notificaciones se mantienen

- El SW sigue escuchando `push` y `notificationclick`.
- Esto no depende de la estrategia de cache de assets.

## Consideraciones y riesgos

- **200 ms es agresivo**: en redes móviles con alta latencia o servidores lejanos, la mayoría de los assets se servirá desde cache. Esto es aceptable si se prioriza velocidad, pero puede retrasar la visibilidad de cambios hasta la próxima carga.
- **Para forzar una actualización inmediata en todos los clientes**, además de cambiar `CACHE_NAME`, conviene que el backend sirva HTML y JS críticos con `Cache-Control: no-cache` o `max-age=0, must-revalidate`.
- **Para saber cuándo un fix impactó a todos los clientes**, se puede agregar un header `X-App-Version` (con el valor de `CACHE_NAME`) en los requests a `/api/` y exponer en el backend qué versiones están usando los clientes activos. Esto no está implementado aún.

## Archivos modificados

- `web/sw.js`: reescrito con la nueva estrategia.
- `web/merchant.html`: registro ajustado a `updateViaCache: "none"`.
- `web/donde.html`: ahora registra `./sw.js` en lugar de `./sw-donde.js`.
- `web/sw-donde.js`: eliminado.
- `ERROR_HANDLING.md`: actualizada referencia al SW unificado.
- `DESIGN_DONDE.md`: actualizada la sección de Service Worker.
