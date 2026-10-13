#!/bin/sh
# Volumes on Railway and most container hosts are mounted root-owned. Fix ownership of the data
# directory while still root, then drop to the unprivileged node user for the actual process.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" /tmp/rewind
  chown -R node:node "$DATA_DIR" /tmp/rewind
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
