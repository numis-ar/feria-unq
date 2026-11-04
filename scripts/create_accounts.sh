#!/usr/bin/env bash

CSV="$1"
[ -z "$CSV" ] && echo missing file && exit 1

tail -n+2 "$CSV" | while IFS=, read -r linea; do
    IFS=',' read -r -a cols <<< "$linea"

    name="${cols[6]}"
    [ -z "$name" ] && continue;
    slug=$(echo $name | iconv -f UTF-8 -t ASCII//TRANSLIT | tr '[:upper:]' '[:lower:]' | LC_ALL=C  sed 's/[^a-zA-Z0-9]//g' | grep -v ^$)
    [ -z "$slug" ] && continue;
    passwd=$(echo $slug numis | md5sum | colrm 9)

    echo taler-harness deployment provision-bank-and-merchant https://merchant.taler.ar https://bank.taler.ar --merchant-management-password=\$MERCHANT_PASSWORD --bank-admin-password=\$BANK_PASSWORD --legal-name="$name" --id="$slug" --password="@$passwd@"
done
