-- Durable sessions, sign-in identities, invitations and share links
-- (ADR-0025, ADR-0026). Nothing existing changes.
--
-- Every secret here is stored as the hex SHA-256 of a 32-byte random token:
-- a copy of this file, or a backup, holds nothing that signs anyone in. A slow
-- hash is unnecessary because the tokens have full entropy; passphrases, which
-- are chosen by people, are argon2id like passwords.

CREATE TABLE share_link (
    id              TEXT PRIMARY KEY,
    canvas_id       TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    label           TEXT,
    created_by      TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Null means permanent.
    expires_at      TEXT,
    -- `{argon2id}…`; null means no passphrase.
    passphrase_hash TEXT,
    revoked_at      TEXT,
    last_used_at    TEXT
);

CREATE INDEX share_link_by_canvas ON share_link (canvas_id);

CREATE TABLE session (
    token_hash   TEXT PRIMARY KEY,
    -- What the account screen and the API call it; the hash never leaves here.
    id           TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('browser', 'device', 'share')),
    user_id      TEXT REFERENCES app_user (id) ON DELETE CASCADE,
    share_id     TEXT REFERENCES share_link (id) ON DELETE CASCADE,
    label        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    -- A share session belongs to a link and to nobody; every other belongs to
    -- an account and to no link.
    CHECK ((kind = 'share') = (share_id IS NOT NULL AND user_id IS NULL)),
    CHECK (kind = 'share' OR user_id IS NOT NULL)
);

CREATE INDEX session_by_user ON session (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX session_by_share ON session (share_id) WHERE share_id IS NOT NULL;
CREATE INDEX session_by_expiry ON session (expires_at);

CREATE TABLE user_identity (
    -- The provider's configuration key: 'google', 'authentik', …
    provider   TEXT NOT NULL,
    -- The ID token's `sub`. Never the email: emails are reassigned and some
    -- providers let people choose them.
    subject    TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    -- Last verified email seen, for display only. Nothing matches on it.
    email      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (provider, subject)
);

CREATE INDEX user_identity_by_user ON user_identity (user_id);

CREATE TABLE invitation (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('join', 'reset')),
    -- reset: whose password. join: null until redeemed, then who joined.
    user_id    TEXT REFERENCES app_user (id) ON DELETE CASCADE,
    -- join: the role the new account gets.
    admin      INTEGER NOT NULL DEFAULT 0,
    note       TEXT,
    created_by TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    CHECK (purpose = 'join' OR user_id IS NOT NULL)
);
