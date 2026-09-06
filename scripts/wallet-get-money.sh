#!/bin/bash
THIS_FILE=$(realpath "$0")
DIR=$(dirname "$THIS_FILE")
cd $DIR
if [[ "$1" =~ ^[0-9]+$ ]]; then
   OK=1
else
    echo "$1 is NOT a positive integer"
    exit 1
fi
$DIR/wallet.sh -L INFO peer-send NUMIS:$1 2>> $DIR/wallet.log | tail -n1
