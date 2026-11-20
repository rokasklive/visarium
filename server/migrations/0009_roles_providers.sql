-- Roles and sign-in providers (instance-administration).

-- One ranked role instead of an admin flag: member < moderator < admin.
ALTER TABLE app_user ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'moderator', 'admin'));
UPDATE app_user SET role = 'admin' WHERE is_admin;
ALTER TABLE app_user DROP COLUMN is_admin;

-- join: the role the new account gets.
ALTER TABLE invitation ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'moderator', 'admin'));
UPDATE invitation SET role = 'admin' WHERE admin;
ALTER TABLE invitation DROP COLUMN admin;

-- OpenID Connect providers an admin set up in the app. Providers from
-- VISARIUM_OIDC_* are not stored here and win on a clash of id. The id is what
-- user_identity.provider stores, so it never changes. client_secret is never
-- sent back by the API.
CREATE TABLE oidc_provider (
    id            TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*' AND length(id) <= 32),
    name          TEXT NOT NULL,
    issuer        TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
