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
  compartido** con la forma `{action, rootCode, title, description, actionHint,
  affectsExperience}`.
- Persistir las métricas en el servidor en **SQLite en memoria** y sincronizar a
  disco de forma configurable.

## Arquitectura

```
                         ┌─────────────────────┐
                         │  server/frontend.js │
      POST /ux-metrics   │  + ux-metrics.js    │
   ┌──────────────────>  │  SQLite :memory:    │
   │                     │  VACUUM INTO disco  │
   │                     └─────────────────────┘
   │
┌──┴──────────────┐
│  web/*.html     │      X-Session-Id header
│  + ux-metrics.js │  ───────────────────────────>
│  + ux-error-    │
│    catalog.js   │      POST /api/ux-metrics    ┌─────────────────────┐
└─────────────────┘  ─────────────────────────> │  server/backend.js  │
                                                │  + backend-ux-      │
                                                │    metrics.js       │
                                                │  SQLite :memory:    │
                                                │  VACUUM INTO disco  │
                                                └─────────────────────┘
```

El núcleo compartido (`server/ux-metrics-core.js`) implementa el esquema, la
ingesta, la query y la persistencia. Cada servidor tiene un adapter liviano que
lee sus variables de entorno y lo cablea:

- `server/ux-metrics.js` → adapter del frontend.
- `server/backend-ux-metrics.js` → adapter del backend.

## Archivos principales

| Archivo | Responsabilidad |
|---|---|
| `web/ux-error-catalog.js` | Catálogo compartido de errores. Cada página lo incluye. |
| `web/ux-metrics.js` | Cliente de telemetría: captura errores, requests, interacciones y load timing. Agrega `X-Session-Id` a cada request del browser. |
| `server/ux-metrics-core.js` | Núcleo compartido: SQLite en memoria, esquema, ingest, query, backup y pruning. |
| `server/ux-metrics.js` | Adapter liviano del frontend. Lee `UX_METRICS_DB_PATH` y expone `POST /ux-metrics` / `GET /ux-metrics`. |
| `server/backend-ux-metrics.js` | Adapter liviano del backend. Expone `POST /api/ux-metrics` / `GET /api/ux-metrics` y helpers de tracking interno. |
| `server/frontend.js` | Sirve el frontend y enruta métricas con `server/ux-metrics.js`. |
| `server/backend.js` | Sirve la API, agrega `X-Session-Id` a CORS, trackea requests entrantes/salientes y eventos de negocio con `server/backend-ux-metrics.js`. |
| `ERROR_HANDLING.md` | Este documento. |

## Catálogo de errores

Cada error catalogado tiene esta forma:

```js
{
  action: "login",                // acción que el usuario intentaba
  rootCode: "MERCHANT_AUTH_401",  // código de error raíz
  title: "Acceso fallido",        // título para el usuario
  description: "El usuario o la contraseña no son válidos.",
  actionHint: "Verificá los datos de acceso.",
  affectsExperience: false,       // ¿impide usar la app como corresponde?
}
```

`affectsExperience` indica si el error es bloqueante:

- `true` → el usuario no puede usar la aplicación como corresponde (500 en un
  endpoint, JSON inválido, sesión expirada, etc.). Se muestra un toast.
- `false` → el usuario puede resolverlo solo o no afecta la funcionalidad
  visible (credenciales incorrectas, recurso que no carga, WS que se desconecta,
  etc.). Solo se reporta; no se muestra toast.

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
  actionHint: "Qué puede hacer el usuario.",
  affectsExperience: true,
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
3. Reporta el evento automáticamente a través de `UXMetrics.trackEvent`.
4. **Solo si `affectsExperience === true`**, muestra un toast con título,
   descripción y `actionHint`.

> **Regla de oro:** si un mensaje de error se muestra al usuario, debe provenir
> del catálogo. Los textos sueltos de `errorEl.textContent = e.message` deben
> migrar a `UXErrorCatalog.show(...)`.
>
> **Regla de oro #2:** los errores que no afectan la experiencia no deben
> mostrarse al usuario. Solo se reportan en `UXMetrics` para monitoreo
> proactivo.

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
- **JSON decode**: intercepta `Response.prototype.json` y reporta
  `json-decode/PARSE_ERROR` como afectante cuando el cuerpo no se puede
  interpretar.
- **WebSocket**: intercepta `WebSocket` y reporta `WS_ERROR` / `WS_CLOSE` no
  limpio como no afectantes.
- **Interacciones**: clicks en elementos con `data-ux-action`, `button`, `a`,
  `input`, `[role="button"]`; submits de formularios.
- **Load timing**: `load`, TTFB, FCP, LCP usando la Performance API.

### Configuración

```js
window.UX_METRICS_CONFIG = {
  endpoint: "/ux-metrics",      // URL de ingest
  flushIntervalMs: 15000,       // flush periódico (mínimo 15s; máximo 1 POST cada 15s)
  sampleRate: 1.0,              // 0.0 - 1.0
  interactionThrottleMs: 500,   // throttle de interacciones
};
```

### API pública

```js
window.UXMetrics.trackEvent(action, rootCode, payload, affectsExperience);
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

## Servidores

Ambos servidores usan el mismo núcleo (`server/ux-metrics-core.js`) con el
mismo esquema, pero cada uno tiene su propia base en memoria y su propio
adapter liviano.

### Frontend (`server/frontend.js` + `server/ux-metrics.js`)

#### Endpoints

- `POST /ux-metrics`
  - Acepta un batch JSON con `session_id`, `events[]`, `requests[]`, `loads[]`.
  - Guarda en SQLite en memoria.
  - Devuelve `204` si tuvo éxito.
  - Está abierto: el browser anónimo lo envía sin autenticar.

- `GET /ux-metrics`
  - Query params: `?since=<ts>&limit=<n>&type=events|requests|loads`.
  - Devuelve JSON con los items almacenados.
  - **Requiere autenticación** si está configurada la variable de entorno
    `UX_METRICS_AUTH_TOKEN`. Header: `Authorization: Bearer <token>`.

#### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `UX_METRICS_DB_PATH` | `.ux-metrics.sqlite` | Ruta del backup en disco. |
| `UX_METRICS_SYNC_MS` | `300000` | Intervalo de sync a disco. |
| `UX_METRICS_MAX_ROWS` | `100000` | Máximo de filas por tabla. |
| `UX_METRICS_AUTH_TOKEN` | `''` | Token Bearer para `GET /ux-metrics`. |

### Backend (`server/backend.js` + `server/backend-ux-metrics.js`)

El backend recibe el mismo `session_id` del browser a través del header
`X-Session-Id` y lo usa para guardar toda la actividad relevante con el mismo
identificador anónimo, permitiendo correlacionar la experiencia.

#### Header `X-Session-Id`

El cliente (`web/ux-metrics.js`) agrega automáticamente el header
`X-Session-Id` a todos los `fetch` y `XMLHttpRequest` excepto a las métricas
propiamente dichas (`/ux-metrics`). El backend lo lee en cada request y lo
propaga a sus propias métricas.

#### Endpoints

- `POST /api/ux-metrics`
  - Mismo formato que `POST /ux-metrics` del frontend.
  - Abierto: recibe batches del browser si se configura el cliente para
    apuntar al backend, o de procesos internos.

- `GET /api/ux-metrics`
  - Query params idénticos a `GET /ux-metrics`.
  - Protegido por `UX_METRICS_AUTH_TOKEN` (mismo token que el frontend).

#### Métricas internas que guarda el backend

- **Requests entrantes**: método, path, status y duración de cada request HTTP.
- **Requests salientes**: llamadas a banco/comerciante hechas por los proxies
  (`/api/bank`, `/api/merchant`, `/api/orders`, `/api/transactions`, etc.) y
  por `upstreamJson` (usado en `/api/state`).
- **Eventos de negocio**:
  - `api-state`: OK / MISSING_AUTH / UPSTREAM_401 / UPSTREAM_ERROR / EXCEPTION.
  - `withdraw`: OK / NOT_ENOUGH_FUNDS / INVALID_AMOUNT / SCRIPT_ERROR.
  - `close-account`: OK / ZERO_BALANCE / NO_BALANCE / UNAUTHORIZED / ERROR.
  - `verify-account`: OK / RESTRICTED_ACCOUNT / NOT_FOUND / ADMIN_TOKEN_ERROR.
  - `admin-notify`, `push-subscribe`, `push-unsubscribe`.

#### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `BACKEND_UX_METRICS_DB_PATH` | `.backend-ux-metrics.sqlite` | Ruta del backup del backend. |
| `UX_METRICS_SYNC_MS` | `300000` | Intervalo de sync a disco (compartida con frontend). |
| `UX_METRICS_MAX_ROWS` | `100000` | Máximo de filas por tabla (compartida). |
| `UX_METRICS_AUTH_TOKEN` | `''` | Token Bearer para `GET /api/ux-metrics` (compartido). |

### Persistencia (ambos servidores)

- La base de datos es SQLite `:memory:`.
- Al iniciar, se intenta restaurar desde el archivo de backup con `ATTACH`.
- Cada `UX_METRICS_SYNC_MS` milisegundos (default `300000` = 5 min) se ejecuta
  `VACUUM INTO` a un archivo temporal y se renombra al path final.
- También se hace backup ante `SIGINT` y `SIGTERM`.
- Se limita el tamaño a `UX_METRICS_MAX_ROWS` filas por tabla (default
  `100000`).

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

## Service workers

El service worker (`web/sw.js`) solo cachea requests
`GET`. Los `POST` se pasan a la red sin intentar escribir en `Cache`, evitando
el error:

```
TypeError: Failed to execute 'put' on 'Cache': Request method 'POST' is unsupported
```

## Cómo consultar las métricas

```bash
# Sin token configurado

# Frontend (puerto 3001 por defecto)
curl http://localhost:3001/ux-metrics
curl "http://localhost:3001/ux-metrics?type=events&since=1699000000000&limit=50"

# Backend (puerto 3000 por defecto)
curl http://localhost:3000/api/ux-metrics
curl "http://localhost:3000/api/ux-metrics?type=requests&limit=1000" | jq '.requests[] | select(.error_code != null)'

# Eventos de negocio generados en el backend
curl "http://localhost:3000/api/ux-metrics?type=events&limit=1000" | jq '.events[] | select(.type == "business")'

# Con token configurado
curl -H "Authorization: Bearer $UX_METRICS_AUTH_TOKEN" http://localhost:3001/ux-metrics
curl -H "Authorization: Bearer $UX_METRICS_AUTH_TOKEN" http://localhost:3000/api/ux-metrics
```

## Decisiones de diseño

- **Anonimato**: la `session_id` se genera por sesión en `sessionStorage`; no
  incluye PII.
- **No bloqueante**: el cliente nunca bloquea la app por fallos de red al
  reportar; usa `sendBeacon` en `beforeunload`.
- **Errores no afectantes**: los errores de recursos (`resource/LOAD_ERROR`),
  WebSocket (`network/WS_ERROR`, `network/WS_CLOSE`) y respuestas 4xx se
  reportan pero no se muestran al usuario.
- **Errores afectantes**: 5xx en endpoints, fallos de red, JSON inválido,
  excepciones JS no controladas, sesión expirada y condiciones de negocio que
  impiden visiblemente una acción (p. ej. sin fondos para retirar/transferir)
  sí muestran toast.
- **No repetición excesiva**: los errores de WebSocket se muestran al usuario
  una sola vez por sesión (`wsErrorReported`), aunque se reportan siempre.
- **Catálogo compartido**: un único archivo permite que todos los sitios
  (`descripcion`, `donde`, `merchant`, `v2`) hablen el mismo lenguaje de
  errores.
- **Correlación frontend/backend**: el mismo `session_id` anónimo viaja en el
  header `X-Session-Id` desde el browser hasta el backend, permitiendo unir
  métricas de navegador con las métricas internas del servidor.
- **Core compartido**: `server/ux-metrics-core.js` centraliza el esquema y la
  persistencia; los adapters son livianos y no duplican lógica.
- **Rate limiting del cliente**: el navegador acumula eventos y envía como
  máximo un POST cada 15 segundos. Los items marcados como
  `affects_experience: true` se envían inmediatamente, bypassando el límite.
- **Flush en cierre**: antes de que el usuario cierre la pestaña se envía todo
  lo acumulado con `sendBeacon`, sin respetar el rate limit.
- **Path `/ux-metrics` (frontend)**: se eligió fuera de `/api/*` para evitar que
  un proxy inverso como nginx redirija las métricas del browser al backend.

## Checklist para nuevas páginas

- [ ] Incluir `ux-error-catalog.js` y `ux-metrics.js` en `<head>`.
- [ ] Agregar `data-ux-action` a botones/formularios importantes.
- [ ] Si se muestra un error, usar `UXErrorCatalog.show(action, rootCode)`.
- [ ] Si se agrega un error nuevo, registrarlo en `web/ux-error-catalog.js` y
      definir `affectsExperience`.
