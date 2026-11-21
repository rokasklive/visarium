-- The storage limit (instance-storage): how much the original images may take,
-- set by an admin in Instance Settings. One row at most; no row, no limit.
CREATE TABLE storage_setting (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    limit_bytes INTEGER CHECK (limit_bytes IS NULL OR limit_bytes > 0),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
