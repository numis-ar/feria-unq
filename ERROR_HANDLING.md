# Estrategia de manejo de errores y métricas de UX

Este documento describe el sistema de captura, catalogación y persistencia de
métricas de experiencia de usuario (UX) de feria-unq. Está diseñado para poder
reaccionar proactivamente ante cualquier error del navegador o de las llamadas a
los endpoints, sin identificar a los usuarios.

## Objetivos

- Capturar **todos** los errores de runtime del navegador (`window.onerror`,
  `unhandledrejection`, fallos de carga de recursos).
- Medir los **tiempos de request** (`fetch`, `XMLHttpRequest`, `WebSocket`).
- Registrar **interacciones** de usuario con una `session_id` anónima.
- Medir **load time** y métricas de pintura (FCP, LCP, TTFB).
- Todos los errores visibles para el usuario deben provenir de un **catálogo
  compartido** con la forma `{action, rootCode, title, description, actionHint}`.
- Persistir las métricas en el servidor en **SQLite en memoria** y sincronizar a
  disco de forma configurable.

## Arquitectura

```
┌─────────────────┐      POST /ux-metrics      ┌─────────────────────┐
│  web/*.html     │  ───────────────────────>  │  server/frontend.js │
│  + ux-metrics.js │                            │  + ux-metrics.js    │
│  + ux-error-    │  <──────────────────────── │  SQLite :memory:    │
│    catalog.js   │      GET /ux-metrics       │  VACUUM INTO disco  │
└─────────────────┘                            └─────────────────────┘
```

## Archivos principales

| Archivo | Responsabilidad |
|---|---|
| `web/ux-error-catalog.js` | Catálogo compartido de errores. Cada página lo incluye. |
| `web/ux-metrics.js` | Cliente de telemetría: captura errores, requests, interacciones y load timing. |
| `server/ux-metrics.js` | Lógica del servidor: SQLite en memoria, ingest, query, backup. |
| `server/frontend.js` | Expone `POST /ux-metrics` y `GET /ux-metrics`. |
| `ERROR_HANDLING.md` | Este documento. |

## Catálogo de errores

Cada error catalogado tiene esta forma:

```js
{
  action: "login",           // acción que el usuario intentaba
  rootCode: "MERCHANT_AUTH_401", // código de error raíz
  title: "Acceso fallido",   // título para el usuario
  description: "El usuario o la contraseña no son válidos.",
  actionHint: "Verificá los datos de acceso."
}
```

### Cómo agregar un nuevo error

Editar `web/ux-error-catalog.js` y agregar una entrada al array `catalog`.
Si no se encuentra una combinación exacta, se resuelve por `action` genérico
(`rootCode: "*"`) y finalmente por el fallback global (`action: "*"`,
`rootCode: "*"`).

```js
window.UXErrorCatalog.add({
  action: "mi-nueva-accion",
  rootCode: "CODIGO_RAIZ",
  title: "Título visible",
  description: "Qué pasó.",
  actionHint: "Qué puede hacer el usuario."
});
```

Desde el código de la página también se puede extender el catálogo en runtime:

```js
window.UXErrorCatalog.add([{ action: "...", rootCode: "...", ... }]);
```

### Mostrar un error al usuario

```js
window.UXErrorCatalog.show("login", "MERCHANT_AUTH_401", "mensaje extra opcional");
```

Esto:
1. Busca la entrada en el catálogo.
2. Dispara el evento `ux-error` con el detalle.
3. Muestra un toast con título, descripción y `actionHint`.
4. Reporta el evento automáticamente a través de `UXMetrics.trackEvent` (solo
   si se llamó desde un flujo de error que no está ya siendo capturado).

> **Regla de oro:** si un mensaje de error se muestra al usuario, debe provenir
> del catálogo. Los textos sueltos de `errorEl.textContent = e.message` deben
> migrar a `UXErrorCatalog.show(...)`.

## Cliente de métricas (`web/ux-metrics.js`)

Se incluye en cada HTML junto con `ux-error-catalog.js`:

```html
<script src="./ux-error-catalog.js"></script>
<script src="./ux-metrics.js"></script>
```

Para páginas en `web/v2/` la ruta es `../ux-error-catalog.js`.

### Qué captura automáticamente

- **Errores JS**: `window.onerror`, `unhandledrejection`, errores de carga de
  recursos (`<img>`, `<script>`, `<link>`, etc.).
- **Requests**: intercepta `fetch` y `XMLHttpRequest` y mide `duration_ms`,
  `status`, `error_code` (`FETCH_404`, `XHR_500`, etc.) y errores de red
  (`FETCH_FAILED`).
- **WebSocket**: intercepta `WebSocket` y reporta `WS_ERROR` / `WS_CLOSE` no
  limpio.
- **Interacciones**: clicks en elementos con `data-ux-action`, `button`, `a`,
  `input`, `[role="button"]`; submits de formularios.
- **Load timing**: `load`, TTFB, FCP, LCP usando la Performance API.

### Configuración

```js
window.UX_METRICS_CONFIG = {
  endpoint: "/ux-metrics",      // URL de ingest
  flushIntervalMs: 10000,       // flush periódico
  batchSize: 50,                // flush inmediato al acumular N items
  sampleRate: 1.0,              // 0.0 - 1.0
  interactionThrottleMs: 500,   // throttle de interacciones
};
```

### API pública

```js
window.UXMetrics.trackEvent(action, rootCode, payload);
window.UXMetrics.trackRequest(method, url, status, durationMs, errorCode, payload);
window.UXMetrics.trackLoad(loadMs, ttfbMs, fcpMs, lcpMs, payload);
window.UXMetrics.flush();
```

### Marcado semántico de interacciones

Para que las métricas sean útiles, agregar `data-ux-action` a los elementos
importantes:

```html
<button data-ux-action="open-withdraw-dialog">Retirar</button>
<form data-ux-action="login-form">...</form>
```

Si no tiene `data-ux-action`, el cliente usa `id`, `name` o el texto del
elemento.

## Servidor (`server/frontend.js` + `server/ux-metrics.js`)

### Endpoints

- `POST /ux-metrics`
  - Acepta un batch JSON con `session_id`, `events[]`, `requests[]`, `loads[]`.
  - Guarda en SQLite en memoria.
  - Devuelve `204` si tuvo éxito.

- `GET /ux-metrics`
  - Query params: `?since=<ts>&limit=<n>&type=events|requests|loads`.
  - Devuelve JSON con los items almacenados.

### Persistencia

- La base de datos es SQLite `:memory:`.
- Al iniciar, se intenta restaurar desde el archivo de backup con `ATTACH`.
- Cada `UX_METRICS_SYNC_MS` milisegundos (default `300000` = 5 min) se ejecuta
  `VACUUM INTO` a un archivo temporal y se renombra al path final.
- También se hace backup ante `SIGINT` y `SIGTERM`.
- Se limita el tamaño a `UX_METRICS_MAX_ROWS` filas por tabla (default
  `100000`).

### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `UX_METRICS_DB_PATH` | `.ux-metrics.sqlite` en la raíz del repo | Ruta del backup en disco. |
| `UX_METRICS_SYNC_MS` | `300000` | Intervalo de sync a disco. |
| `UX_METRICS_MAX_ROWS` | `100000` | Máximo de filas por tabla. |

## Flujos de error por página

### `donde.html`

- Fallo al cargar `productores.json` → `UXErrorCatalog.show("load-productores", "FETCH_500", err.message)`.
- Fallo al copiar link → `UXErrorCatalog.show("share", "CLIPBOARD")`.
- Share API no disponible → `UXErrorCatalog.show("share", "NOT_SUPPORTED")`.

### `merchant.html`

- Login fallido → `UXErrorCatalog.show("login", "MERCHANT_AUTH_401", err.message)`.
- Sesión expirada → `UXErrorCatalog.show("session", "EXPIRED")`.
- Sin fondos → `UXErrorCatalog.show("no-funds", "BALANCE_ZERO")`.
- Retiro fallido → `UXErrorCatalog.show("withdraw", "FETCH_500", e.message)`.
- Confirmación de retiro fallida → `UXErrorCatalog.show("withdraw", "CONFIRM_FAILED", e.message)`.
- Cierre de caja fallido → `UXErrorCatalog.show("close-account", "FETCH_500", e.message)`.
- Cambio de contraseña fallido → `UXErrorCatalog.show("change-password", "FETCH_500", e.message)`.
- Transferencia: alias no encontrado → `UXErrorCatalog.show("transfer", "FETCH_404", e.message)`; otros errores → `"transfer", "FETCH_500"`.

### `puesto.html` y `descripcion.html`

- Los errores JS, de red y de recursos se capturan automáticamente.
- Si se agregan acciones interactivas nuevas, usar `UXErrorCatalog.show`.

## Cómo consultar las métricas

```bash
# Últimos 100 items de cualquier tipo
curl http://localhost:3001/ux-metrics

# Últimos eventos desde una timestamp
curl "http://localhost:3001/ux-metrics?type=events&since=1699000000000&limit=50"

# Requests con error
curl "http://localhost:3001/ux-metrics?type=requests&limit=1000" | jq '.requests[] | select(.error_code != null)'
```

## Decisiones de diseño

- **Anonimato**: la `session_id` se genera por sesión en `sessionStorage`; no
  incluye PII.
- **No bloqueante**: el cliente nunca bloquea la app por fallos de red al
  reportar; usa `sendBeacon` en `beforeunload`.
- **No repetición excesiva**: los errores de WebSocket se muestran al usuario
  una sola vez por sesión (`wsErrorReported`), aunque se reportan siempre.
- **Catálogo compartido**: un único archivo permite que todos los sitios
  (`descripcion`, `donde`, `merchant`, `v2`) hablen el mismo lenguaje de
  errores.
- **Path `/ux-metrics`**: se eligió fuera de `/api/*` para evitar que un proxy
  inverso como nginx redirija las métricas al backend (`server/backend.ts`).

## Checklist para nuevas páginas

- [ ] Incluir `ux-error-catalog.js` y `ux-metrics.js` en `<head>`.
- [ ] Agregar `data-ux-action` a botones/formularios importantes.
- [ ] Si se muestra un error, usar `UXErrorCatalog.show(action, rootCode)`.
- [ ] Si se agrega un error nuevo, registrarlo en `web/ux-error-catalog.js`.
