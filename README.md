# Visarium

A persistent, infinite canvas for collecting and arranging image references —
on your desktop on its own, or self-hosted with other people on it.

Rust (axum + SQLite) server, React + Vite web app, Tauri desktop shell.

## Running it

Needs Node ≥ 24, stable Rust, pnpm and [just](https://just.systems).

```sh
pnpm install
just dev        # Rust server on :8080 + Vite on :5173
just desktop    # the desktop app
just test       # Rust and TypeScript tests
just            # everything else
```

Self-hosted: `docker compose up -d` (settings in `.env.example`).

## Licence

Not yet chosen.
