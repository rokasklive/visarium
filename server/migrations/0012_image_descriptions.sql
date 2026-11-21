-- Image descriptions (image-descriptions): one vision model for the instance,
-- and what it said about each image.

-- The admin's setting. One row at most. VISARIUM_VISION_* in the environment
-- wins over it. api_key is never sent back by the API.
CREATE TABLE vision_setting (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    base_url   TEXT NOT NULL,
    api_key    TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL,
    prompt     TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per asset (an asset is one set of bytes, so identical images share
-- it). No row: waiting. The text columns keep the last good description while
-- a redo with a new model is pending or failing. prompt_hash names the setting
-- (base URL, model, prompt) the latest attempt used: a row whose hash differs
-- from the current setting's is done again.
CREATE TABLE image_description (
    asset_id        TEXT PRIMARY KEY REFERENCES asset (id) ON DELETE CASCADE,
    caption         TEXT,
    description     TEXT,
    visible_text    TEXT,
    model           TEXT,
    described_at    TEXT,
    prompt_hash     TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('done', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    error           TEXT,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
