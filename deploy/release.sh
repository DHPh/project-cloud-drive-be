#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: release.sh <40-character commit SHA> with a gzipped Docker image on stdin.' >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo 'Run this installation-owned script through the configured sudo rule.' >&2
  exit 2
fi

root=/opt/project-cloud-drive-be
image="cloud-drive-be:$1"
compose_file="$root/compose.production.yaml"
env_file="$root/api.env"
if [[ ! -r "$compose_file" || ! -r "$env_file" ]]; then
  echo 'Install the production Compose file and configure api.env before releasing.' >&2
  exit 1
fi

cd "$root"
exec 9>"$root/release.lock"
flock -n 9 || { echo 'A backend release is already running.' >&2; exit 1; }
trap 'echo "Backend release failed. Check the deployment output and recovery runbook before switching images or restoring data." >&2' ERR

compose() {
  CLOUD_DRIVE_IMAGE="$image" CLOUD_DRIVE_API_ENV_FILE="$env_file" \
    docker compose --project-directory "$root" -f "$compose_file" "$@"
}

compose config --quiet
gzip -dc | docker image load
revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
if [[ "$revision" != "$1" ]]; then
  echo 'Loaded image revision does not match the requested release.' >&2
  exit 1
fi

compose run --rm --no-deps -T api node -e 'const c = require("./dist/config.js"); c.appConfig(); c.databaseUrl(); c.storageConfig();'
compose stop api
compose run --rm --no-deps -T api node dist/cli.js migrate
compose up -d --no-deps --wait --wait-timeout 60 api

record="$(mktemp "$root/current-image.XXXXXX")"
printf '%s\n' "$image" >"$record"
mv -f -- "$record" "$root/current-image"
printf 'Backend healthy on the local bind for revision %s.\n' "$1"
