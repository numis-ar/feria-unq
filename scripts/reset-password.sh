#!/bin/bash
[ -z "$1" ] && echo missing user && exit 1
USER=$1
PASSWORD=".numis123."

set -e
echo ====== USR $USER

sudo -u taler-merchant-httpd TALER_MERCHANT_PASSWORD=$PASSWORD taler-merchant-passwd -i "$USER" || true
sudo -u libeufin-bank libeufin-bank passwd "$USER" "$PASSWORD" -L WARN || true

TOKEN=$(curl -s -u "admin:$MERCHANT_PASSWORD" -H "Content-Type: application/json" -d '{"scope":"all"}' https://merchant.taler.ar/instances/admin/private/token | jq -r '.access_token // .token')
if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
  ACCOUNT=$(curl -s -H "Authorization: Bearer $TOKEN" https://merchant.taler.ar/instances/$USER/private/accounts | jq -r .accounts[0].h_wire)
  if [ -n "$ACCOUNT" ] && [ "$ACCOUNT" != "null" ]; then
    curl -s -X PATCH -H "Authorization: Bearer $TOKEN" https://merchant.taler.ar/instances/$USER/private/accounts/$ACCOUNT -d '{"credit_facade_credentials": {"type":"basic", "username":"'$USER'","password":"'$PASSWORD'"}}'
  fi
fi
echo password reset completed for $USER
