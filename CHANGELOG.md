# Changelog

## 0.1.0

- Organize image references, notes, diagrams, and checklists on an infinite canvas.
- Let a vision model describe every image, so agents whose model cannot see pictures still know what they show, and search finds images by their content. Admins set it up under Instance Settings → Vision model, with any OpenAI-compatible endpoint, or with VISARIUM_VISION_* on the server.
- Connect Claude, ChatGPT, Cursor and other MCP apps to a self-hosted server by its address alone. You sign in and approve the app in your browser, and it appears under Settings → Agents, where you can revoke it. Agent tokens still work. This needs VISARIUM_PUBLIC_URL to be set.
- Work in a desktop library or connect to a self-hosted Visarium server.
- Find the version, build, diagnostic collection, and update controls in Settings → About.
- Security fixes from an audit. Agent tokens only work as bearer tokens on /mcp, and the server no longer accepts them as a sign-in cookie. Open boards stop updating within a minute of their session being signed out.
- Self-hosted servers: images are now marked Cache-Control: private. If a caching proxy or CDN sits in front of your server, purge its cache for /api/assets/ after upgrading.

## 0.0.2

- Verify the replacement Mac build and current-version changelog after an in-app alpha update.

## 0.0.1

- Check for a signed alpha update and collect diagnostic logs from Settings → About.
