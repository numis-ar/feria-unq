
NAME=$1
[ -z "$NAME" ] && echo missing name && exit 1

DEFAULT_PWD=.numis123.
#ID=miradatextil
#NAME="Mirada Textil"

ID=$(echo $name | iconv -f UTF-8 -t ASCII//TRANSLIT | tr '[:upper:]' '[:lower:]' | LC_ALL=C  sed 's/[^a-zA-Z0-9]//g' | grep -v ^$)

taler-harness deployment provision-bank-and-merchant https://merchant.taler.ar https://bank.taler.ar --merchant-management-password=$MERCHANT_PASSWORD --bank-admin-password=4db8b0c502f11bb3a7dff5d302bb71f1 "--legal-name=$NAME" "--id=$ID" --password=$DEFAULT_PWD

# imprimir frente
#./cartel/generar-cartel.py --izquierda "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" --derecha "taler://pay-template/merchant.taler.ar/instances/$ID/UNQ" "$NAME" -o ${ID}_frente.pdf

# imprimir reverso
#./credencial/generar-credencial.py --izquierda "https://unq.numis.ar/productorxs?usr=$ID" "$ID" --derecha "https://unq.numis.ar/productorxs?usr=$ID" "$ID" -o ${ID}_reverso.pdf

#cat $HOME/users/pwd  | sudo -S ls -f > /dev/null

#sudo /home/linuxadmin/admin/change_password.sh $ID


