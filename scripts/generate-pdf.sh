#!/bin/bash
ID=$1

[ -z "$ID" ] && echo missing id && exit 1

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

# Obtener el legal name desde el merchant backend
TOKEN=$(curl -s -u "admin:$MERCHANT_PASSWORD" -H "Content-Type: application/json" -d '{"scope":"all"}' https://merchant.taler.ar/instances/admin/private/token | jq -r '.access_token // .token')
NAME=$(curl -s -H "Authorization: Bearer $TOKEN" https://merchant.taler.ar/management/instances/$ID | jq -r '.name // "'$ID'"')

mkdir -p web/pdf web/pdfs

# imprimir frente
python3 web/cartel/generar-cartel.py --izquierda "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" --derecha "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" -o web/pdf/${ID}_frente.pdf
python3 web/cartel/generar-cartel.py --izquierda "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" --derecha "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" -o web/pdfs/${ID}_frente.pdf

# imprimir reverso
python3 web/credencial/generar-credencial.py --izquierda "https://unq.numis.ar/productorxs?usr=$ID" "$ID" --derecha "https://unq.numis.ar/productorxs?usr=$ID" "$ID" -o web/pdf/${ID}_reverso.pdf
python3 web/credencial/generar-credencial.py --izquierda "https://unq.numis.ar/productorxs?usr=$ID" "$ID" --derecha "https://unq.numis.ar/productorxs?usr=$ID" "$ID" -o web/pdfs/${ID}_reverso.pdf

echo "PDFs generated for $ID ($NAME)"
