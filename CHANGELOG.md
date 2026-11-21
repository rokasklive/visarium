# Changelog

## 0.1.0

- Organize image references, notes, diagrams, and checklists on an infinite canvas.
- Work in a desktop library or connect to a self-hosted Visarium server.
- Find the version, build, diagnostic collection, and update controls in Settings → About.
- Security fixes from an audit. Agent tokens only work as bearer tokens on /mcp, and the server no longer accepts them as a sign-in cookie. Open boards stop updating within a minute of their session being signed out.
- Self-hosted servers: images are now marked Cache-Control: private. If a caching proxy or CDN sits in front of your server, purge its cache for /api/assets/ after upgrading.

## 0.0.2

- Verify the replacement Mac build and current-version changelog after an in-app alpha update.

## 0.0.1

- Check for a signed alpha update and collect diagnostic logs from Settings → About.
