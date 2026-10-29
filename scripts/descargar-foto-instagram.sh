#!/usr/bin/env bash
# Descarga la foto de perfil de un usuario de Instagram y la guarda en
# web/productores/<handle>.jpg. Luego vincula esa imagen al productor que tenga
# el mismo handle en el campo 'instagram' de web/productores.json.
#
# Uso:
#   ./scripts/descargar-foto-instagram.sh <handle-de-instagram> [--cookies archivo]
#
# Ejemplos:
#   ./scripts/descargar-foto-instagram.sh feria.unq
#   ./scripts/descargar-foto-instagram.sh feria.unq --cookies ./cookies.txt
#   INSTAGRAM_COOKIES_FILE=./cookies.txt ./scripts/descargar-foto-instagram.sh feria.unq
#
# Requiere: curl.
# Recomendado: file (valida el tipo de imagen).
# Nota: Instagram no tiene una API pública oficial para esto. El script usa
# endpoints no documentados que pueden dejar de funcionar o requerir sesión.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/web/productores"
JSON_FILE="$REPO_ROOT/web/productores.json"

HANDLE=""
COOKIE_FILE="${INSTAGRAM_COOKIES_FILE:-}"

# Parseo mínimo de argumentos.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cookies)
      COOKIE_FILE="${2:-}"
      shift 2
      ;;
    --help|-h)
      echo "Uso: $0 <handle-de-instagram> [--cookies archivo]"
      exit 0
      ;;
    -*)
      echo "Opción desconocida: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$HANDLE" ]; then
        HANDLE="$1"
      else
        echo "Solo se permite un handle." >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$HANDLE" ]; then
  echo "Uso: $0 <handle-de-instagram> [--cookies archivo]" >&2
  exit 1
fi

# Normalizar handle: sacar @ inicial y espacios.
HANDLE="$(echo "$HANDLE" | sed 's/^@//' | tr -d ' ')"

OUT_FILE="$OUTPUT_DIR/${HANDLE}.jpg"
mkdir -p "$OUTPUT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROFILE_JSON="$TMP_DIR/profile.json"
PROFILE_HTML="$TMP_DIR/profile.html"

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
  -o "$PROFILE_JSON" || true

if [ -f "$PROFILE_JSON" ]; then
  # Intentar extraer la URL sin depender de jq.
  IMG_URL="$(grep -oP '"profile_pic_url_hd":"\K[^"]+' "$PROFILE_JSON" | head -n1 || true)"
  if [ -z "$IMG_URL" ]; then
    IMG_URL="$(grep -oP '"profile_pic_url":"\K[^"]+' "$PROFILE_JSON" | head -n1 || true)"
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
    -o "$PROFILE_HTML" || true

  if [ -f "$PROFILE_HTML" ]; then
    IMG_URL="$(grep -oP '"profile_pic_url_hd":"\K[^"]+' "$PROFILE_HTML" | head -n1 || true)"
    if [ -z "$IMG_URL" ]; then
      IMG_URL="$(grep -oP '"profile_pic_url":"\K[^"]+' "$PROFILE_HTML" | head -n1 || true)"
    fi
    if [ -z "$IMG_URL" ]; then
      IMG_URL="$(grep -oP '<meta property="og:image" content="\K[^"]+' "$PROFILE_HTML" | head -n1 || true)"
    fi
  fi
fi

if [ -z "$IMG_URL" ]; then
  echo "No se pudo obtener la URL de la foto de perfil." >&2
  echo "Instagram puede requerir inicio de sesión, haber bloqueado la solicitud o el usuario puede ser privado." >&2
  echo "Sugerencia: exportá las cookies de tu navegador con una extensión como 'Get cookies.txt' y pasalas con --cookies." >&2
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

# Vincular la imagen con el productor en productores.json.
echo "Actualizando $JSON_FILE..."
node --input-type=module - "$REPO_ROOT" "$HANDLE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.argv[2];
const handle = process.argv[3];
const jsonPath = path.join(repoRoot, 'web', 'productores.json');
const imagePath = `./productores/${handle}.jpg`;

let data;
try {
  data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (err) {
  console.error('No se pudo leer productores.json:', err.message);
  process.exit(1);
}

let found = false;
for (const p of data) {
  if (p.instagram && p.instagram.toLowerCase() === handle.toLowerCase()) {
    p.imagen = imagePath;
    found = true;
    console.log(`Vinculada imagen a: ${p.nombreEmprendimiento}`);
    break;
  }
}

fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');

if (!found) {
  console.error(`No se encontró un productor con instagram="${handle}".`);
  console.error('La imagen se guardó pero no se vinculó al JSON.');
  process.exit(2);
}
NODE

if [ $? -eq 0 ]; then
  echo "Listo. La próxima vez que recargues /donde.html se verá la foto real."
else
  echo "Aviso: no se pudo vincular la foto a ningún productor." >&2
fi
