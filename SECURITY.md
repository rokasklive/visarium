# Security

## Reporting a vulnerability

Please **don't** open a public issue for security problems.

Report them privately through [GitHub's private vulnerability reporting](https://github.com/rokasklive/visarium/security/advisories/new). Include:

- what the issue is and what an attacker could do with it
- the affected version (Settings → About) and setup: desktop, or self-hosted and how it's deployed
- steps to reproduce, or a proof of concept

You'll get a reply within a week. Once a fix is ready, it ships in a release and the advisory is published, crediting you unless you'd rather stay anonymous.

## Supported versions

Visarium is pre-1.0. Only the latest release receives security fixes, so please upgrade before reporting.

## Scope

These are in scope:

- the server: API, realtime sync, MCP endpoint, sign-in (OpenID Connect and passwords), agent tokens, asset storage
- the web app
- the desktop app, including its updater
- the production Docker image and the default `compose.yml`

These are out of scope:

- vulnerabilities in a dependency that Visarium can't reach (`cargo deny` tracks advisories, and any that are ignored are explained in `deny.toml`)
- problems that require an already-compromised server, an admin account, or physical access to the machine
- self-hosted deployments that go against the documented setup, for example exposing the server without TLS or turning on password sign-in with weak passwords
- what an agent does on a board that its user gave it access to. Agents act with their user's permissions by design. A way for an agent to go beyond them is in scope.

## Self-hosting safely

- Put the server behind TLS, and set `VISARIUM_PUBLIC_URL` to its public address.
- Prefer OpenID Connect sign-in. Password sign-in stays off unless `VISARIUM_AUTH_PASSWORD=on` is set.
- Review the agents connected to your account under Settings → Agents, and revoke any you don't use.
- Back up `data/db` and `data/assets`, or wherever `DATABASE_HOST_PATH` and `ASSETS_HOST_PATH` point.
