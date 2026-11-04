
ID=$1

[ -z "$ID" ] && echo missing id && exit 1

# FIXME: Obtener el legal name desde el merchant backend
NAME=test


# imprimir frente
./cartel/generar-cartel.py --izquierda "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" --derecha "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" -o /home/ia/feria-unq/web/pdfs/${ID}_frente.pdf

# imprimir reverso
./credencial/generar-credencial.py --izquierda "https://unq.numis.ar/productorxs?usr=$ID" "$ID" --derecha "https://unq.numis.ar/productorxs?usr=$ID" "$ID" -o /home/ia/feria-unq/web/pdfs/${ID}_reverso.pdf



