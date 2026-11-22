<p align="center">
  <img src="docs/media/logo.svg" alt="Visarium" width="420">
</p>

<p align="center">
  <b>An infinite canvas for image references, built for people and their agents.</b><br>
  Runs as a local desktop app, or self-hosted for live collaboration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0">
  <img src="https://img.shields.io/badge/Rust-axum%20%C2%B7%20SQLite-orange" alt="Rust">
  <img src="https://img.shields.io/badge/React-Vite-61dafb" alt="React">
  <img src="https://img.shields.io/badge/Tauri-desktop-ffc131" alt="Tauri">
  <img src="https://img.shields.io/badge/MCP-ready-8a2be2" alt="MCP">
</p>

---

Moodboards, reference sheets, research and screenshots all go on a board that scrolls and zooms without limit. Drop images onto it, add notes, diagrams and checklists, link related items, and zoom out to see the whole picture.

## Features

- **Infinite canvas**: the board has no edges.
- **Drag in, drag out**: bring in files from a folder or a browser, one at a time or in batches, and drag images back out.
- **Edit in place**: resize, rotate and crop images on the board. Animated GIFs keep playing.
- **Notes, diagrams, checklists**: Markdown notes keep formatting when you paste, and diagrams are written in Mermaid or PlantUML.
- **Typed links**: links between items say what they mean (`describes`, `implements`, `depends-on` and so on), not just "connected".
- **Agents on your boards**: connect Claude, ChatGPT, Cursor or any other MCP client to a self-hosted server using only its address. Approve access once and revoke it any time.
- **Built-in vision**: point the server at any OpenAI-compatible vision model and every image gets a description that agents and search can use.
- **Your auth**: sign in with an OpenID Connect provider, or switch on password sign-in.

## Quick start

Requires Node ≥ 24, stable Rust, pnpm and [just](https://just.systems).

```sh
pnpm install
just dev        # server on :8080 + web on :5173
just desktop    # desktop app
just test       # Rust + TypeScript tests
just            # all recipes
```

**Self-host:** `docker compose up -d` (configure from `.env.example`).

> [!NOTE]
> The Linux desktop app works, but it has had less testing than the macOS and Windows builds. Dropped files land at the centre of the window, and pasting a copied file does not work yet.

## License

[AGPL-3.0-only](LICENSE) © 2026 Rokas Kučinskas. If you run a modified version as a network service, you must offer its source to the people who use it. Contributions are accepted under the same license.
