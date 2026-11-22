# Visarium. `just` on its own lists the recipes.
#
# Machine-local overrides (API_PORT, WEB_PORT, SINGLE_USER) go in .env.local,
# which is gitignored.

set dotenv-load
set dotenv-filename := ".env.local"

api_port := env("API_PORT", "8080")
web_port := env("WEB_PORT", "5173")
# Development signs every request in as one implicit admin, so a server restart
# does not sign you out. SINGLE_USER=false exercises setup and sign-in.
single_user := env("SINGLE_USER", "true")

export VISARIUM_PORT := api_port
export VISARIUM_BIND := "127.0.0.1"
export VISARIUM_SINGLE_USER := single_user
# The server keeps password sign-in off unless asked; development asks, so
# SINGLE_USER=false works with no provider set up.
export VISARIUM_AUTH_PASSWORD := env("AUTH_PASSWORD", "on")
export VITE_BACKEND_URL := "http://localhost:" + api_port

default:
    @just --list

# Rust server + Vite in one terminal; Ctrl-C stops both
dev:
    #!/usr/bin/env bash
    echo "  backend   http://localhost:{{api_port}}"
    echo "  frontend  http://localhost:{{web_port}}   <- open this one"
    trap 'kill 0' EXIT
    cargo run -q -p visarium-server &
    pnpm --filter @visarium/web dev --port {{web_port}} --strictPort &
    wait -n

# Just the server
backend:
    cargo run -p visarium-server

# Just Vite (--strictPort: a silently moved port breaks the proxy and cookies)
frontend:
    pnpm --filter @visarium/web dev --port {{web_port}} --strictPort

# Regenerate web/public/licenses.txt after changing dependencies
licenses:
    node web/scripts/licenses.mjs

# The desktop app
desktop:
    pnpm desktop

# A release .app / installer
desktop-build:
    pnpm desktop:build

# Everything CI checks: formatting, lints, types, dependencies, then the tests
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    pnpm check
    pnpm typecheck
    cargo deny check
    node web/scripts/licenses.mjs --check
    just test

# Rust and TypeScript tests, and proof the production bundle has no dev tools
test:
    cargo test --workspace
    pnpm test
    pnpm --filter @visarium/web build
    pnpm --filter @visarium/web check:bundle

# The production image, but with the inspector: for a dev environment
dev-image:
    WEB_BUILD=dev docker compose build

# Build and start the production image (--build, or a code change looks like it did nothing)
prod:
    docker compose up -d --build --wait
    @echo "  http://localhost:${APP_PORT:-8080}"

prod-stop:
    docker compose down

prod-logs:
    docker compose logs -f

# /mcp against the official MCP SDK client, on a throwaway single-user server
mcp-conformance:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(mktemp -d)
    port=18765
    VISARIUM_PORT=$port VISARIUM_SINGLE_USER=true VISARIUM_DATABASE="$dir/visarium.db" \
      VISARIUM_ASSETS_PATH="$dir/assets" VISARIUM_DERIVATIVES_PATH="$dir/derivatives" \
      cargo run -q -p visarium-server &
    pid=$!
    trap 'kill $pid 2>/dev/null; rm -rf "$dir"' EXIT
    for _ in $(seq 1 240); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
    node server/tests/mcp-conformance.mjs "http://127.0.0.1:$port/mcp"

# The agent eval: each task in server/tests/agent_eval/tasks.json run by Claude Code (args: --model M --only id,id --label name)
agent-eval *args:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(mktemp -d)
    port=18766
    VISARIUM_PORT=$port VISARIUM_SINGLE_USER=true VISARIUM_DATABASE="$dir/visarium.db" \
      VISARIUM_ASSETS_PATH="$dir/assets" VISARIUM_DERIVATIVES_PATH="$dir/derivatives" \
      cargo run -q -p visarium-server &
    pid=$!
    trap 'kill $pid 2>/dev/null; rm -rf "$dir"' EXIT
    for _ in $(seq 1 240); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
    node server/tests/agent_eval/run.mjs "http://127.0.0.1:$port" {{args}}
