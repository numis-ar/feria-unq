#!/bin/bash
[ -z "$SUDO_USER" ] && echo no enough permissions && exit 1
[ -z "$1" ] && echo missing user && exit 1
USER=$1
PASSWORD=".numis123."


set -e
echo ====== USR $USER

sudo -u taler-merchant-httpd TALER_MERCHANT_PASSWORD=$PASSWORD taler-merchant-passwd -i $USER
echo merchant changed...

# FIXME: por alguna razon no se puede cambiar el password para que comienze con @ en libeufin
sudo -u libeufin-bank libeufin-bank passwd $USER "$PASSWORD"  -L WARN
echo bank changed...

TOKEN=$(curl -s -H "Authorization: Basic $(echo -n $USER:$PASSWORD | base64)" https://merchant.taler.ar/instances/$USER/private/token -d '{"scope":"write", "duration": {"d_us": 10000000}}' | jq .access_token -r)
ACCOUNT=$(curl -s -H "Authorization: Bearer $TOKEN" https://merchant.taler.ar/instances/$USER/private/accounts | jq -r .accounts[0].h_wire)
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" https://merchant.taler.ar/instances/$USER/private/accounts/$ACCOUNT -d '{"credit_facade_credentials": {"type":"basic", "username":"'$USER'","password":"'$PASSWORD'"}}'
echo revenue changed...

