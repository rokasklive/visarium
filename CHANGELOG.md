# Changelog

## v0.2.0

- Visarium now has a light theme and follows your computer's light or dark setting, switching when it does. Pick Light or Dark instead under Settings → Appearance; the choice is kept on that device. If your computer is in light mode, Visarium opens light after this update.
- Updates the cookie library for a security advisory about processes that fork (RUSTSEC-2026-0594). Visarium does not fork, so it was not affected.

## v0.1.0

- First release. An infinite canvas for image references, Markdown notes, Mermaid and PlantUML diagrams, and checklists, with typed links that say how items relate.
- Every item and diagram element has a stable reference, such as d2#Server or c1/t3, so you and your agents point at exactly the same thing.
- Agents work on boards through the built-in MCP server. Claude, ChatGPT, Cursor and other MCP apps connect to a self-hosted server by its address alone; you approve them in your browser and revoke them under Settings → Agents. Their edits are credited to them and appear live.
- Notes can be decisions or open questions. Agents propose them, and you settle them.
- A vision model can describe every image, so agents that cannot see pictures still know what they show, and search finds images by their content. Set it up under Instance Settings → Vision model with any OpenAI-compatible endpoint.
- Drag images in from folders and browsers, one at a time or in batches, and drag them back out. Crop, resize and rotate them on the board.
- The desktop app for macOS, Windows and Linux keeps a library on your machine and also connects to self-hosted servers. It updates itself from Settings → About.
- Self-host the server as one Docker image for amd64 and arm64. People sign in through an OpenID Connect provider, or with a password when VISARIUM_AUTH_PASSWORD=on. Admins manage sign-in providers, moderators and a storage limit in Instance Settings.
