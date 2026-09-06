#!/bin/bash
THIS_FILE=$(realpath "$0")
DIR=$(dirname "$THIS_FILE")

cd $DIR

PATH=$PATH:$PWD/install-prefix/bin/ ./install-prefix/bin/taler-wallet-cli --wallet-db=$DIR/ia-wallet.db $@
