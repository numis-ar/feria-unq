# Design decisions

This document records the main design decisions taken for the Feria UNQ frontend pages and server.

## 1. All static resources are served locally

**Decision:** Every CSS file, JavaScript file, font and image used by `descripcion.html`, `merchant.html` and `puesto.html` is served from this project, never fetched from a third-party domain.

**Rationale:**
- The fair may be run in environments with limited or no internet access.
- Avoids external points of failure (CDNs, QR APIs, font services).
- Keeps user privacy: no requests leak to Google Fonts, qrserver.com, etc.

**Consequences:**
- The Archivo font family was downloaded and is now hosted under `web/fonts/`.
- `merchant.html` no longer calls `api.qrserver.com`; it generates withdrawal QRs locally with the same `qrcode-generator.js` library already used by the other pages.
- `puesto.html` references `puesto-feria.png` with a relative path inside `web/` instead of `../puesto-feria.png`.

## 2. Consistent local font across all pages

**Decision:** All three public pages link to `./fonts/archivo.css`.

**Rationale:**
- Before this change only `merchant.html` loaded Archivo from Google Fonts; `descripcion.html` and `puesto.html` declared the font family but relied on the system having it installed.
- Hosting the same font files once and reusing them guarantees consistent typography without external requests.

## 3. Friendly `puesto-$ID` URLs with an internal QR map

**Decision:** `puesto.html` supports two ways to receive a QR payload:

1. Legacy explicit value: `puesto.html?qr=<raw-qr-text>`.
2. Named ID: `/puesto-<id>`, where `<id>` is looked up in an internal JavaScript map (`PUESTO_MAP`) embedded in the page.

**Rationale:**
- Named IDs are short, human-friendly and easy to print or share (e.g. `./puesto-test`).
- The map keeps the actual Taler payment URI in one place, so links can be changed without touching every HTML file.
- The legacy `?qr=` parameter is preserved for one-off or dynamic cases.

**Consequences:**
- `server/frontend.js` rewrites any `/puesto-<id>` path to `puesto.html` so the static file is served and the client-side script can read the ID from `location.pathname`.
- `merchant.html` now links to `./puesto-test`; the corresponding entry in `PUESTO_MAP` holds `taler://pay-template/merchant.taler.ar/instances/test/UNQ`.

## 4. Local QR generation in `merchant.html`

**Decision:** The withdrawal QR is rendered on a canvas using `window.qrcode` from `qrcode-generator.js`, then converted to a PNG data URL.

**Rationale:**
- Replaces the previous dependency on `api.qrserver.com`.
- Reuses the same QR library already shipped for `puesto.html` and `descripcion.html`.
- Keeps the existing `<img>` structure and loading/error UI with minimal changes.

## 5. Accessibility improvements in `descripcion.html`

**Decision:** The guide page received a focused accessibility pass before adding the image modal.

Changes:
- `html lang="es"`, `<title>` and meta description.
- Skip link to the main content.
- `aria-label` on the main navigation.
- Keyboard-focusable screenshot figures with `role="button"` and descriptive `aria-label`.
- Fixed duplicated/non-descriptive `alt` texts on screenshots.

## 6. Screenshot modal/lightbox in `descripcion.html`

**Decision:** Clicking any screenshot opens an almost-full-screen modal with previous/next controls, keyboard navigation, swipe gestures and a focus trap.

**Rationale:**
- The guide is heavily image-based; users on mobile need an easy way to inspect screenshots.
- Navigation is scoped to the screenshots within the same step, cycling around.
- Keyboard (Escape, arrow keys) and swipe support make it usable on both desktop and mobile.
- Focus is trapped inside the modal while open and returned to the thumbnail on close.

## 7. No external links were converted when they are not resource loads

**Decision:** Functional hyperlinks such as `https://billetera.numis.ar/`, `https://unq.numis.ar/descripcion` and `/cierre` were left unchanged.

**Rationale:**
- These are user-facing navigation targets, not assets the browser loads automatically.
- QR `url` attributes are data encoded into a locally-rendered QR code, not network requests.
