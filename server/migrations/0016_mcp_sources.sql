-- MCP servers as a source for canvas apps (openspec canvas-apps-live §10).
--
--  * A connection belongs to one board, so a duplicated board can carry it.
--    Its token stays here: no read, response or app view ever includes it.
--    Exactly one of url (Streamable HTTP) and command (stdio, desktop only).
--  * A `ui://` resource's HTML, pinned by content hash. An app names the hash
--    it shows; a newer fetch adds a row and the app offers the update.

CREATE TABLE mcp_connection (
    id          TEXT PRIMARY KEY,
    canvas_id   TEXT NOT NULL REFERENCES canvas(id) ON DELETE CASCADE,
    url         TEXT CHECK (url IS NULL OR length(url) <= 2000),
    command     TEXT CHECK (command IS NULL OR length(command) <= 2000),
    token       TEXT CHECK (token IS NULL OR length(token) <= 4000),
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((url IS NULL) <> (command IS NULL))
);
CREATE INDEX mcp_connection_canvas ON mcp_connection(canvas_id);

CREATE TABLE app_resource (
    sha256      TEXT PRIMARY KEY,
    html        TEXT NOT NULL CHECK (length(CAST(html AS BLOB)) <= 10485760),
    csp         TEXT NOT NULL DEFAULT '{}' CHECK (json_type(csp) = 'object'),
    fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The newest hash seen for each connection's resource: when it differs from
-- the one an app pins, that app has an update available.
CREATE TABLE mcp_resource_head (
    connection_id TEXT NOT NULL REFERENCES mcp_connection(id) ON DELETE CASCADE,
    uri           TEXT NOT NULL,
    sha256        TEXT NOT NULL REFERENCES app_resource(sha256),
    PRIMARY KEY (connection_id, uri)
);
