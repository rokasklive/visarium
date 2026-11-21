-- OAuth for /mcp (mcp-oauth). A client that signs in becomes an ordinary agent
-- session; its access and refresh tokens point at that session.

-- A client: registered dynamically (random id), or known by its Client ID
-- Metadata Document (the id is the document's URL). used_at is set by the
-- first completed sign-in; a registered client never used is pruned.
CREATE TABLE oauth_client (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    from_document INTEGER NOT NULL DEFAULT 0,
    fetched_at    TEXT,
    used_at       TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Which client an agent session was connected by. Null for a minted token.
ALTER TABLE session ADD COLUMN oauth_client_id TEXT;

CREATE TABLE oauth_token (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at TEXT NOT NULL,
    -- A refresh token is used once; presenting it again revokes the session.
    used_at    TEXT
);
CREATE INDEX oauth_token_by_session ON oauth_token (session_id);
CREATE INDEX oauth_token_by_expiry ON oauth_token (expires_at);
