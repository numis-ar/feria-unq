#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Uso: $0 archivo.pdf" >&2
    exit 1
fi

pdf=$1

if [[ ! -f "$pdf" || ! -r "$pdf" ]]; then
    echo "Error: no se puede leer el archivo: $pdf" >&2
    exit 1
fi

if ! command -v lp >/dev/null 2>&1; then
    echo "Error: no se encontró el comando 'lp'. Instalá CUPS para poder imprimir." >&2
    exit 1
fi

lp \
    -o media=A4 \
    -o print-color-mode=color \
    -o fit-to-page \
    -o page-top=0 \
    -o page-bottom=0 \
    -o page-left=0 \
    -o page-right=0 \
    -- "$pdf"
