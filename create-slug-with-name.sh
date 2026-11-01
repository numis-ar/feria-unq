#!/bin/bash

FILE=$1
[ -z "$FILE" ] && missing file as first arg && exit 1

cut -d=, -f7 "$FILE" | iconv -f UTF-8 -t ASCII//TRANSLIT | tr '[:upper:]' '[:lower:]' | LC_ALL=C  sed 's/[^a-zA-Z0-9]//g' | grep -v ^$
