#!/usr/bin/env bash
# Descarga la foto de perfil pública de un usuario de Instagram a partir de su handle.
# Uso:
#   ./scripts/descargar-foto-instagram.sh <handle> [directorio-de-salida] [archivo-cookies]
# Ejemplo:
#   ./scripts/descargar-foto-instagram.sh feria.unq ./web/screenshots ./cookies.txt
#
# También se puede usar la variable de entorno INSTAGRAM_COOKIES_FILE:
#   INSTAGRAM_COOKIES_FILE=./cookies.txt ./scripts/descargar-foto-instagram.sh feria.unq
#
# Requiere: curl, jq (opcional pero recomendado), file (opcional).
# Nota: Instagram no tiene una API pública oficial para esto. El script usa
# endpoints no documentados que pueden dejar de funcionar o requerir sesión.

set -euo pipefail

HANDLE="${1:-}"
OUTPUT_DIR="${2:-./web/screenshots}"
COOKIE_FILE="${3:-${INSTAGRAM_COOKIES_FILE:-}}"

if [ -z "$HANDLE" ]; then
  echo "Uso: $0 <handle-de-instagram> [directorio-de-salida] [archivo-cookies]" >&2
  echo "   o: INSTAGRAM_COOKIES_FILE=./cookies.txt $0 <handle> [directorio-de-salida]" >&2
  exit 1
fi

# Normalizar handle: sacar @ inicial y espacios.
HANDLE="$(echo "$HANDLE" | sed 's/^@//' | tr -d ' ')"

OUT_FILE="${OUTPUT_DIR%/}/instagram-${HANDLE}.jpg"
mkdir -p "$OUTPUT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

JSON_FILE="$TMP_DIR/profile.json"
HTML_FILE="$TMP_DIR/profile.html"

USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
IG_APP_ID="936619743392459"

CURL_COOKIE_ARGS=()
if [ -n "$COOKIE_FILE" ]; then
  if [ ! -f "$COOKIE_FILE" ]; then
    echo "No se encontró el archivo de cookies: $COOKIE_FILE" >&2
    exit 1
  fi
  CURL_COOKIE_ARGS=(--cookie "$COOKIE_FILE")
  echo "Usando cookies desde: $COOKIE_FILE"
fi

IMG_URL=""

echo "Buscando foto de perfil para @${HANDLE}..."

# Método 1: endpoint no oficial de perfil web (devuelve JSON).
curl -sL \
  -H "User-Agent: $USER_AGENT" \
  -H "Accept: */*" \
  -H "X-IG-App-ID: $IG_APP_ID" \
  -H "Referer: https://www.instagram.com/" \
  "${CURL_COOKIE_ARGS[@]}" \
  "https://www.instagram.com/api/v1/users/web_profile_info/?username=${HANDLE}" \
  -o "$JSON_FILE" || true

if [ -f "$JSON_FILE" ] && command -v jq >/dev/null 2>&1; then
  if jq -e '.data.user' "$JSON_FILE" >/dev/null 2>&1; then
    IMG_URL="$(jq -r '.data.user.profile_pic_url_hd // .data.user.profile_pic_url // empty' "$JSON_FILE")"
  fi
fi

# Método 2: descargar la página HTML y buscar la URL en el JSON embebido.
if [ -z "$IMG_URL" ]; then
  echo "No se obtuvo JSON válido. Intentando con la página HTML..."
  curl -sL \
    -H "User-Agent: $USER_AGENT" \
    -H "Accept: text/html,application/xhtml+xml" \
    -H "Referer: https://www.instagram.com/" \
    "${CURL_COOKIE_ARGS[@]}" \
    "https://www.instagram.com/${HANDLE}/" \
    -o "$HTML_FILE" || true

  if [ -f "$HTML_FILE" ]; then
    IMG_URL="$(grep -oP '"profile_pic_url_hd":"\K[^"]+' "$HTML_FILE" | head -n1 || true)"
    if [ -z "$IMG_URL" ]; then
      IMG_URL="$(grep -oP '"profile_pic_url":"\K[^"]+' "$HTML_FILE" | head -n1 || true)"
    fi
    if [ -z "$IMG_URL" ] && command -v jq >/dev/null 2>&1; then
      # Algunas respuestas tienen un bloque <script type="application/ld+json">.
      IMG_URL="$(grep -oP '<script type="application/ld\+json">\K.*?(?=</script>)' "$HTML_FILE" | jq -rs 'map(fromjson? // empty) | .. | objects | .image? // .contentUrl? // empty' | head -n1 || true)"
    fi
  fi
fi

if [ -z "$IMG_URL" ]; then
  echo "No se pudo obtener la URL de la foto de perfil." >&2
  echo "Instagram puede requerir inicio de sesión, haber bloqueado la solicitud o el usuario puede ser privado." >&2
  echo "Sugerencia: exportá las cookies de tu navegador con una extensión como 'Get cookies.txt' y pasalas como tercer argumento o en INSTAGRAM_COOKIES_FILE." >&2
  exit 1
fi

echo "Descargando imagen desde: $IMG_URL"
curl -sL \
  -H "User-Agent: $USER_AGENT" \
  -H "Referer: https://www.instagram.com/" \
  "${CURL_COOKIE_ARGS[@]}" \
  "$IMG_URL" \
  -o "$OUT_FILE"

# Validar que el archivo sea una imagen.
if command -v file >/dev/null 2>&1; then
  MIME="$(file -b --mime-type "$OUT_FILE")"
  case "$MIME" in
    image/jpeg|image/png|image/webp)
      echo "Guardado en: $OUT_FILE (tipo: $MIME)"
      ;;
    text/html)
      echo "Error: Instagram devolvió HTML en lugar de la imagen (probablemente requiere login)." >&2
      rm -f "$OUT_FILE"
      exit 1
      ;;
    *)
      echo "Guardado en: $OUT_FILE (tipo inesperado: $MIME)" >&2
      ;;
  esac
else
  echo "Guardado en: $OUT_FILE"
fi
