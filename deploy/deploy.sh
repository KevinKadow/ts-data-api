#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
state=${READER_DEPLOY_STATE:-"$root/.deployment"}
input=${READER_DEPLOY_INPUT:-"$root/deployment-input"}
transfer=${READER_DEPLOY_TRANSFER:-"$root/deployment-transfer"}
mkdir -p -- "$state" "$input" "$transfer"
state=$(cd -- "$state" && pwd)
input=$(cd -- "$input" && pwd)
transfer=$(cd -- "$transfer" && pwd)
chmod 700 "$state" "$input" "$transfer"
docker build --target deployment-tools -t ts-data-api-deployment-tools "$root"
revision=$(git -C "$root" rev-parse --short HEAD)
if [ -n "$(git -C "$root" status --porcelain)" ]; then revision="$revision-dirty"; fi
tty=()
if [ -t 0 ] && [ -t 1 ]; then tty=(-it); else tty=(-i); fi
docker run --rm "${tty[@]}" --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e DEPLOY_REVISION="$revision" \
  --mount "type=bind,source=$state,target=/state" \
  --mount "type=bind,source=$input,target=/input,readonly" \
  --mount "type=bind,source=$transfer,target=/transfer" \
  ts-data-api-deployment-tools "$@"
