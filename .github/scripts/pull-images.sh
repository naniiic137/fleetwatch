#!/usr/bin/env bash
# Pull Docker Hub images in CI without depending on Docker Hub, which answers
# anonymous pulls from runners with "429 Too Many Requests". Each image comes
# from a registry that serves the same image (quay.io for prom/*, Google's
# Docker Hub mirror mirror.gcr.io for the rest), with retries, and is tagged
# with its usual name so docker build, docker compose and kind find it locally.
# Docker Hub itself is only the last resort.
#
#   bash .github/scripts/pull-images.sh python:3.12-slim prom/prometheus:v3.5.0
set -uo pipefail

sources() {
  local image="$1" first="${1%%/*}"
  if [[ "$image" == */* && ( "$first" == *.* || "$first" == *:* ) ]]; then
    echo "$image"   # already names a registry
    return
  fi
  case "$image" in
    prom/*) echo "quay.io/prometheus/${image#prom/}" ;;
    */*)    echo "mirror.gcr.io/$image" ;;
    *)      echo "mirror.gcr.io/library/$image" ;;
  esac
  echo "$image"
}

status=0
for image in "$@"; do
  ok=0
  for src in $(sources "$image"); do
    for attempt in 1 2 3; do
      if docker pull -q "$src" > /dev/null; then
        [ "$src" = "$image" ] || docker tag "$src" "$image"
        echo "$image <- $src"
        ok=1
        break 2
      fi
      sleep $((attempt * 5))
    done
  done
  if [ "$ok" != 1 ]; then
    echo "could not pull $image" >&2
    status=1
  fi
done
exit "$status"
