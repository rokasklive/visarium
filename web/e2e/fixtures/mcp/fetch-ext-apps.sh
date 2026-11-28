#!/usr/bin/env bash
# The views of three official MCP Apps examples (modelcontextprotocol/ext-apps,
# MIT), for canvas.apps.ext-apps.spec.ts: only each package's built
# dist/mcp-app.html is kept, in web/node_modules/.cache/ext-apps. Their
# servers are not run; fixtures/mcp/ext-apps-server.mjs answers their tools.
set -euo pipefail
version=2.0.4
out="$(cd "$(dirname "$0")/../../.." && pwd)/node_modules/.cache/ext-apps"
mkdir -p "$out"
for name in basic-vanillajs budget-allocator cohort-heatmap; do
  [ -s "$out/$name.html" ] && continue
  tmp=$(mktemp -d)
  (cd "$tmp" && npm pack --silent "@modelcontextprotocol/server-$name@$version" >/dev/null)
  tar -xzf "$tmp"/*.tgz -C "$tmp" package/dist/mcp-app.html
  mv "$tmp/package/dist/mcp-app.html" "$out/$name.html"
  rm -rf "$tmp"
done
ls -1 "$out"
