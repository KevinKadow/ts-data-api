#!/bin/sh
set -eu
READER_PROXY_SECRET=$(cat /run/secrets/proxy)
test -n "$READER_PROXY_SECRET"
export READER_PROXY_SECRET
exec "$@"
