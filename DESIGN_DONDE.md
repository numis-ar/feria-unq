# Decisiones de diseño: `web/donde.html`

Este documento resume las decisiones tomadas para la página de ubicación y listado de productorxs de la Feria UNQ.

## 1. Arquitectura general

- `web/donde.html` sigue siendo un archivo estático en disco.
- El listado de productorxs vive en `web/productores.json`, que es estático pero fácil de editar.
- `server/frontend.js` hace un **SSR ligero** solo para `GET /donde.html?p=<slug>`: lee `productores.json`, busca el productor e inyecta metatags OG/Twitter en el HTML antes de servirlo.
- El cliente (JavaScript de `donde.html`) carga el JSON, renderiza las cards, filtra, ordena y abre el modal de detalles.

## 2. Estructura de la página

- **Header e intro**: mismo estilo visual que `descripcion.html` (colores, tipografía, espaciado).
- **Mapa**: imagen `mapa-unq.png` clickeable, enlaza a Google Maps.
- **Listado de productorxs**: grid de cards. Cada card muestra:
  - imagen a la izquierda,
  - nombre del emprendimiento como título,
  - descripción corta,
  - tag de rubro.
- **Modal**: aparece al hacer click en una card. Diseño de tarjeta de contacto con foto circular, datos de contacto con iconos y botones de redes sociales.

## 3. Datos y privacidad

- Un objeto `CAMPOS_VISIBLES` en el JS permite ocultar globalmente cualquier campo (teléfono, email, redes, etc.) como si no estuviera presente en el JSON.
- Solo se muestran los datos que existen y que la administración decidió mostrar.

## 4. Búsqueda y filtros

- **Buscador fuzzy**: filtra mientras se escribe.
- Se normaliza el texto (minúsculas, sin tildes) y se usa una **firma fonética simplificada** para español rioplatense (`c/s`, `v/b`, `y/i`, `z/s`, `ll/y`, etc.).
- Los resultados se ordenan por relevancia: nombre > persona > rubro > descripción > organización > ubicación.
- **Filtro por rubro**: select con los rubros únicos del JSON.
- **Orden**: aleatorio por defecto; también se puede ordenar por nombre, rubro o ubicación.

## 5. Orden aleatorio justo

- Al cargar la página se genera una semilla aleatoria que se guarda en `sessionStorage`.
- Esa semilla se usa para mezclar el listado con `mulberry32`.
- Durante toda la sesión el orden se mantiene estable; al recargar se puede generar uno nuevo.

## 6. Compartir y Open Graph

- Compartir genera `https://unq.numis.ar/donde.html?p=<slug>`.
- `server/frontend.js` responde a esa URL con el HTML original pero reescribiendo `<title>`, `description`, `og:*`, `twitter:*` y `canonical` con los datos del productor.
- Los crawlers de WhatsApp/Telegram leen los metatags server-side.
- Los usuarios que abren el link llegan al mismo `donde.html`, donde el JS detecta `?p=` y abre el modal.
- Se mantiene compatibilidad con links antiguos `donde.html#<slug>`.

## 7. Service Worker

- Se usa un único service worker (`web/sw.js`) registrado desde todas las páginas.
- Cachea solo assets estáticos (JS, CSS, fuentes, imágenes, manifiesto).
- **Nunca cachea** páginas `.html`, rutas `/api/*`, `/get-money`, `productores.json` ni `/share/*`.
- Estrategia *network-first* con timeout de 200 ms: si la red responde antes se usa la versión fresca; si tarda más se sirve el cache y se actualiza en background.
- El registro usa `updateViaCache: "none"` para evitar que el navegador use el cache HTTP al buscar actualizaciones del SW.
- El JSON se carga con `fetch(..., { cache: "no-store" })` para ver cambios de contenido inmediatamente.

## 8. Imágenes de perfil

- Mientras no haya fotos reales se usa `web/screenshots/productor-placeholder.svg`.
- `scripts/descargar-foto-instagram.sh` descarga la foto de perfil de un handle de Instagram, la guarda en `web/productores/<handle>.jpg` y vincula esa imagen al productor correspondiente en `web/productores.json`.
- El script soporta cookies (`--cookies archivo.txt` o `INSTAGRAM_COOKIES_FILE`) porque Instagram suele bloquear requests anónimas.

## 9. Accesibilidad (a11y)

- Skip-link para saltar al contenido principal.
- Roles ARIA (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-live`).
- Foco visible con outline naranja.
- Cards navegables con teclado (Enter/Espacio abre el modal).
- Trap de foco dentro del modal.
- Cierre con Escape o click fuera del modal.
- Contraste y tipografía coherentes con el resto del sitio.

## 10. Futuras mejoras posibles

- Cache con invalidación en `server/frontend.js` si `productores.json` crece mucho (hoy se lee en cada request a `/donde.html`).
- Precarga o lazy-loading de imágenes reales una vez que se descarguen.
- Sitemap o listado canónico si en algún momento importa el SEO.
