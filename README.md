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

Copyright © 2026 Rokas Kučinskas.

Visarium is free software under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). If you run a modified version as a network service, you must offer its
source to the people who use it.

Contributions are accepted under the same licence.
