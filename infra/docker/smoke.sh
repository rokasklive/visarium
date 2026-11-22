#!/usr/bin/env bash
# Starts an image and checks it answers like a server with its web bundle in:
#   infra/docker/smoke.sh visarium:local
set -euo pipefail
image=$1
id=$(docker run -d -p 127.0.0.1::8080 -e VISARIUM_AUTH_PASSWORD=on "$image")
trap 'docker logs "$id" | tail -50; docker rm -f "$id" >/dev/null' EXIT
url="http://$(docker port "$id" 8080/tcp | head -1)"
for _ in $(seq 1 60); do curl -sf "$url/health/readiness" | grep -q UP && break; sleep 1; done
curl -sf "$url/health/readiness" | grep -q UP
# A release binary without web/dist answers "this build has no web bundle".
curl -sf "$url/" | grep -q '<script'
echo "smoke: $image is up at $url"
