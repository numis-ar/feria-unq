#!/bin/bash
NAME=$1
[ -z "$NAME" ] && echo missing name && exit 1

DEFAULT_PWD=.numis123.

ID=$(echo $NAME | iconv -f UTF-8 -t ASCII//TRANSLIT | tr '[:upper:]' '[:lower:]' | LC_ALL=C  sed 's/[^a-zA-Z0-9]//g' | grep -v ^$)

[ -z "$ID" ] && echo invalid id generated && exit 1

taler-harness deployment provision-bank-and-merchant https://merchant.taler.ar https://bank.taler.ar --merchant-management-password=$MERCHANT_PASSWORD --bank-admin-password=$BANK_PASSWORD "--legal-name=$NAME" "--id=$ID" --password=$DEFAULT_PWD

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
"$ROOT_DIR/scripts/generate-pdf.sh" "$ID"

echo "$ID"
