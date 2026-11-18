-- Visarium schema, SQLite. The Postgres migrations V1–V6 folded into one.
--
-- The reasoning behind each table and constraint is unchanged from the Postgres
-- history (git log -- server/src/main/resources/db/migration); only what SQLite
-- spells differently is noted here:
--
--  * uuids are TEXT, lowercase hyphenated, minted by the application (UUIDv7).
--    Lexicographic order of a v7 uuid is its time order, so `id` still works as
--    the cursor tiebreak.
--  * timestamps are TEXT, ISO-8601 UTC with milliseconds, which also sorts
--    lexicographically in time order.
--  * booleans are INTEGER 0/1.
--  * Foreign keys are enforced per connection (the pool turns them on).

CREATE TABLE app_user (
    id             TEXT PRIMARY KEY,
    username       TEXT    NOT NULL UNIQUE,
    display_name   TEXT    NOT NULL,
    -- `{bcrypt}$2b$...`: the algorithm prefix is kept so a future default can
    -- change without invalidating stored hashes. Null for an account with no
    -- local password.
    password_hash  TEXT,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    deactivated_at TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE asset (
    id                TEXT PRIMARY KEY,
    -- SHA-256 of the original bytes. Unique: the same image is stored once.
    content_hash      TEXT    NOT NULL UNIQUE,
    storage_key       TEXT    NOT NULL,
    original_filename TEXT,
    mime_type         TEXT    NOT NULL,
    byte_size         INTEGER NOT NULL CHECK (byte_size > 0),
    width             INTEGER NOT NULL CHECK (width > 0),
    height            INTEGER NOT NULL CHECK (height > 0),
    source_url        TEXT,
    source_page_url   TEXT,
    uploaded_by       TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Null means present. A deleted asset is recoverable until purged.
    deleted_at        TEXT
);

CREATE INDEX asset_by_created_at ON asset (created_at DESC, id DESC);
CREATE INDEX asset_by_created_at_live ON asset (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX asset_by_filename ON asset (lower(original_filename), id);

CREATE TABLE canvas (
    id         TEXT PRIMARY KEY,
    title      TEXT    NOT NULL,
    owner_id   TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    -- Monotonic per canvas; every committed operation bumps it.
    revision   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE canvas_group (
    id        TEXT PRIMARY KEY,
    canvas_id TEXT    NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    label     TEXT,
    frame     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE canvas_item (
    id         TEXT PRIMARY KEY,
    canvas_id  TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    -- RESTRICT: removing an item must never delete the file behind it.
    asset_id   TEXT NOT NULL REFERENCES asset (id) ON DELETE RESTRICT,
    group_id   TEXT REFERENCES canvas_group (id) ON DELETE SET NULL,
    -- World space. (x, y) is the CENTRE; rotation is radians about it.
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    width      REAL NOT NULL CHECK (width > 0),
    height     REAL NOT NULL CHECK (height > 0),
    rotation   REAL NOT NULL DEFAULT 0,
    z          REAL NOT NULL DEFAULT 0,
    opacity    REAL NOT NULL DEFAULT 1 CHECK (opacity >= 0 AND opacity <= 1),
    flip_x     INTEGER NOT NULL DEFAULT 0,
    flip_y     INTEGER NOT NULL DEFAULT 0,
    revision   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX canvas_item_by_canvas ON canvas_item (canvas_id, z);
CREATE INDEX canvas_item_by_asset ON canvas_item (asset_id);
CREATE INDEX canvas_item_by_group ON canvas_item (group_id) WHERE group_id IS NOT NULL;

-- Logical collections, explicitly not directories.
CREATE TABLE collection (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (owner_id, name)
);

CREATE TABLE asset_collection (
    asset_id      TEXT NOT NULL REFERENCES asset (id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collection (id) ON DELETE CASCADE,
    added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (asset_id, collection_id)
);

CREATE INDEX asset_collection_by_collection ON asset_collection (collection_id);
