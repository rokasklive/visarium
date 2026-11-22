# Contributing

Thanks for wanting to help. Visarium is pre-1.0 and moves fast, so a short conversation before a big change saves everyone time.

## Before you start

- **Bugs**: open an issue with your platform (macOS, Windows, Linux, or self-hosted), the version from Settings → About, and steps to reproduce.
- **Small fixes** (typos, obvious bugs, docs): open a pull request directly.
- **Features and larger changes**: open an issue first so we can agree on the shape. Pull requests that arrive unannounced may not fit where the project is heading.
- **Security issues**: don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You'll need Node ≥ 24, stable Rust, pnpm and [just](https://just.systems).

```sh
pnpm install
just dev        # server on :8080 + web on :5173
just desktop    # desktop app
```

`just` on its own lists every recipe. Machine-local overrides (ports, `SINGLE_USER=false` to exercise sign-in) go in `.env.local`.

## Before you open a pull request

```sh
just check
```

This runs everything CI runs: formatting, Clippy, Biome, types, `cargo deny`, the license list, and every test. A pull request that fails `just check` won't be merged.

If you add or change a dependency, run `just licenses` and commit the updated `web/public/licenses.txt`.

## How the code is laid out

| Path | What lives there |
| --- | --- |
| `server/` | Rust server (axum + SQLite): API, realtime sync, MCP, assets |
| `web/` | React web app |
| `desktop/` | Tauri desktop app, which embeds the server |
| `packages/canvas-core` | Canvas model: geometry, camera, operations. No React, Konva or DOM. |
| `packages/*` | Renderer, API client and other shared packages |

Some rules the code relies on:

- `canvas-core` stays free of React, Konva and the DOM. A test enforces this. If it fails, move your code rather than loosening the test.
- Every durable canvas change is a `CanvasOperation` applied through the document, whether it's local or remote.
- Pointer handlers never wait on a network request.
- Board items never go into Zustand, which holds only transient UI state.

## Pull requests

- Keep each pull request to one change. Small ones get reviewed faster.
- Add a test for anything with logic in it.
- Write commit messages as one plain sentence about what changes for the user, for example "Take file drops from Linux file managers". Skip prefixes like `feat:`.
- Add a line to `CHANGELOG.md` for anything a user would notice.
- AI-assisted contributions are welcome. You're responsible for the result: read it, run it, and be ready to explain it.

## License

Visarium is licensed under [AGPL-3.0-only](LICENSE). By contributing, you agree that your contribution is licensed under the same terms. There is no CLA.
