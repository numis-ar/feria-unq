#!/bin/bash

THIS_FILE=$(realpath "$0")
DIR=$(dirname "$THIS_FILE")
name=feria-unq_frontend
set -xe

systemctl --user enable $DIR/system/$name.service
systemctl --user enable $DIR/system/$name.socket

systemctl --user edit --stdin $name.service --drop-in=local.conf <<EOF
[Service]
Environment=APP_DIR=${DIR}
WorkingDirectory=${DIR}
EOF

