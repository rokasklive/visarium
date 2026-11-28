-- Canvas apps (ADR-0034, openspec canvas-apps-poc). An item can be an `app`:
-- an interactive HTML view whose durable outputs other items and agents read.
-- Links gain two data types, `feeds` (an item's view into an app) and
-- `updates` (an app may propose changes to a checklist), which grant access
-- where the four semantic types never do.
--
-- SQLite cannot change a CHECK in place, so canvas_item and canvas_link are
-- rebuilt. Foreign keys are on and this runs in one transaction, where the
-- pragma cannot be turned off; dropping canvas_item would cascade into every
-- link. So links are first parked in a table with no constraints, canvas_item
-- is rebuilt with nothing referencing it, and canvas_link is recreated from
-- the parked rows.
--
--  * An app's body is JSON { title, html }: up to 256 KiB, every other kind
--    keeps 64 KiB.
--  * content_rev counts changes to what an item shows (its body, asset or
--    lang), not where it is. An app's output is stamped with its inputs'
--    content_rev, so moving a note does not make the apps it feeds stale.
--    Existing rows start at 0: no output exists yet to compare against.

CREATE TABLE canvas_link_parked AS SELECT * FROM canvas_link;
DROP TABLE canvas_link;

CREATE TABLE canvas_item_next (
    id            TEXT PRIMARY KEY,
    canvas_id     TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'note', 'diagram', 'checklist', 'app')),
    -- RESTRICT: removing an item must never delete the file behind it.
    asset_id      TEXT REFERENCES asset (id) ON DELETE RESTRICT,
    lang          TEXT CHECK (lang IN ('mermaid', 'plantuml')),
    body          TEXT CHECK (length(CAST(body AS BLOB)) <= CASE kind WHEN 'app' THEN 262144 ELSE 65536 END),
    group_id      TEXT REFERENCES canvas_group (id) ON DELETE SET NULL,
    x             REAL NOT NULL,
    y             REAL NOT NULL,
    width         REAL NOT NULL CHECK (width > 0),
    height        REAL NOT NULL CHECK (height > 0),
    rotation      REAL NOT NULL DEFAULT 0,
    z             REAL NOT NULL DEFAULT 0,
    opacity       REAL NOT NULL DEFAULT 1 CHECK (opacity >= 0 AND opacity <= 1),
    flip_x        INTEGER NOT NULL DEFAULT 0,
    flip_y        INTEGER NOT NULL DEFAULT 0,
    crop_x        REAL,
    crop_y        REAL,
    crop_w        REAL,
    crop_h        REAL,
    revision      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ref_no        INTEGER NOT NULL DEFAULT 0,
    collides      INTEGER NOT NULL DEFAULT 0,
    element_boxes TEXT CHECK (length(CAST(element_boxes AS BLOB)) <= 262144),
    element_rev   INTEGER,
    text_scale    REAL CHECK (text_scale IS NULL OR (text_scale >= 0.25 AND text_scale <= 8)),
    home_x        REAL,
    home_y        REAL,
    content_rev   INTEGER NOT NULL DEFAULT 0,
    CHECK ((kind = 'image') = (asset_id IS NOT NULL)),
    CHECK ((kind = 'image') = (body IS NULL)),
    CHECK ((kind = 'diagram') = (lang IS NOT NULL)),
    CHECK (
        (crop_x IS NULL AND crop_y IS NULL AND crop_w IS NULL AND crop_h IS NULL)
        OR (kind = 'image' AND crop_x >= 0 AND crop_y >= 0 AND crop_w > 0 AND crop_h > 0
            AND crop_x + crop_w <= 1.000000001 AND crop_y + crop_h <= 1.000000001)
    )
);

INSERT INTO canvas_item_next (id, canvas_id, kind, asset_id, lang, body, group_id, x, y, width, height, rotation, z,
                              opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h, revision, created_at, updated_at,
                              ref_no, collides, element_boxes, element_rev, text_scale, home_x, home_y)
SELECT id, canvas_id, kind, asset_id, lang, body, group_id, x, y, width, height, rotation, z,
       opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h, revision, created_at, updated_at,
       ref_no, collides, element_boxes, element_rev, text_scale, home_x, home_y
  FROM canvas_item;

DROP TABLE canvas_item;
ALTER TABLE canvas_item_next RENAME TO canvas_item;

CREATE INDEX canvas_item_by_canvas ON canvas_item (canvas_id, z);
CREATE INDEX canvas_item_by_asset ON canvas_item (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX canvas_item_by_group ON canvas_item (group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX canvas_item_by_ref ON canvas_item (canvas_id, kind, ref_no);

-- A `feeds` link carries the view of its source the app reads (canvas/item-views);
-- no other link has one.
CREATE TABLE canvas_link (
    id               TEXT PRIMARY KEY,
    canvas_id        TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    from_item        TEXT NOT NULL REFERENCES canvas_item (id) ON DELETE CASCADE,
    from_element     TEXT CHECK (length(from_element) BETWEEN 1 AND 200),
    to_item          TEXT NOT NULL REFERENCES canvas_item (id) ON DELETE CASCADE,
    to_element       TEXT CHECK (length(to_element) BETWEEN 1 AND 200),
    link_type        TEXT NOT NULL CHECK (link_type IN ('describes', 'comments', 'implements', 'depends-on', 'feeds', 'updates')),
    created_by       TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by_agent TEXT,
    view             TEXT CHECK (length(view) BETWEEN 1 AND 40),
    CHECK (from_item <> to_item OR coalesce(from_element, '') <> coalesce(to_element, '')),
    CHECK ((link_type = 'feeds') = (view IS NOT NULL))
);

INSERT INTO canvas_link (id, canvas_id, from_item, from_element, to_item, to_element, link_type, created_by, created_at,
                         created_by_agent)
SELECT id, canvas_id, from_item, from_element, to_item, to_element, link_type, created_by, created_at, created_by_agent
  FROM canvas_link_parked;
DROP TABLE canvas_link_parked;

CREATE INDEX canvas_link_by_canvas ON canvas_link (canvas_id);
CREATE INDEX canvas_link_by_from ON canvas_link (from_item);
CREATE INDEX canvas_link_by_to ON canvas_link (to_item);

-- One row per run of an app: what it produced, from which inputs, by whom.
-- Never rewritten; undo commits an earlier version's values as a new one.
CREATE TABLE app_output (
    item_id      TEXT NOT NULL REFERENCES canvas_item (id) ON DELETE CASCADE,
    version      INTEGER NOT NULL CHECK (version > 0),
    outputs      TEXT NOT NULL CHECK (json_type(outputs) = 'object' AND length(CAST(outputs AS BLOB)) <= 16384),
    text         TEXT CHECK (length(CAST(text AS BLOB)) <= 16384),
    -- { "<input item id>": <its content_rev when the run committed> }
    input_revs   TEXT NOT NULL CHECK (json_type(input_revs) = 'object'),
    status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    error        TEXT CHECK (length(error) <= 2000),
    run_by       TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    run_by_agent TEXT,
    run_at       TEXT NOT NULL,
    PRIMARY KEY (item_id, version)
);
