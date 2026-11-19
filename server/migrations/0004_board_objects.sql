-- Board objects and links. An item is no longer always an image: it has a
-- kind, and a note, diagram or checklist stores text in `body` instead of
-- pointing at an asset. Links between items (or named elements inside a
-- diagram) are their own rows.
--
-- SQLite cannot drop NOT NULL from a column in place, so canvas_item is
-- rebuilt: new table, copy, drop, rename. Nothing references canvas_item at
-- this point (canvas_link is created after), so the drop cascades nowhere.
-- Every existing row is an image.
--
--  * asset_id is set exactly when kind = 'image'; body exactly when it isn't.
--  * lang is set exactly for diagrams.
--  * body is the Markdown or diagram source, or for a checklist the JSON
--    { title, tasks: [{ id, text, state, by, at }] }. 64 KiB is far past any
--    real note and short of anything that would hurt a snapshot.
--  * crop (0003) belongs to images only.

CREATE TABLE canvas_item_next (
    id         TEXT PRIMARY KEY,
    canvas_id  TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('image', 'note', 'diagram', 'checklist')),
    -- RESTRICT: removing an item must never delete the file behind it.
    asset_id   TEXT REFERENCES asset (id) ON DELETE RESTRICT,
    lang       TEXT CHECK (lang IN ('mermaid', 'plantuml')),
    body       TEXT CHECK (length(CAST(body AS BLOB)) <= 65536),
    group_id   TEXT REFERENCES canvas_group (id) ON DELETE SET NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    width      REAL NOT NULL CHECK (width > 0),
    height     REAL NOT NULL CHECK (height > 0),
    rotation   REAL NOT NULL DEFAULT 0,
    z          REAL NOT NULL DEFAULT 0,
    opacity    REAL NOT NULL DEFAULT 1 CHECK (opacity >= 0 AND opacity <= 1),
    flip_x     INTEGER NOT NULL DEFAULT 0,
    flip_y     INTEGER NOT NULL DEFAULT 0,
    crop_x     REAL,
    crop_y     REAL,
    crop_w     REAL,
    crop_h     REAL,
    revision   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((kind = 'image') = (asset_id IS NOT NULL)),
    CHECK ((kind = 'image') = (body IS NULL)),
    CHECK ((kind = 'diagram') = (lang IS NOT NULL)),
    CHECK (
        (crop_x IS NULL AND crop_y IS NULL AND crop_w IS NULL AND crop_h IS NULL)
        OR (kind = 'image' AND crop_x >= 0 AND crop_y >= 0 AND crop_w > 0 AND crop_h > 0
            AND crop_x + crop_w <= 1.000000001 AND crop_y + crop_h <= 1.000000001)
    )
);

INSERT INTO canvas_item_next (id, canvas_id, kind, asset_id, group_id, x, y, width, height, rotation, z,
                              opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h, revision, created_at, updated_at)
SELECT id, canvas_id, 'image', asset_id, group_id, x, y, width, height, rotation, z,
       opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h, revision, created_at, updated_at
  FROM canvas_item;

DROP TABLE canvas_item;
ALTER TABLE canvas_item_next RENAME TO canvas_item;

CREATE INDEX canvas_item_by_canvas ON canvas_item (canvas_id, z);
CREATE INDEX canvas_item_by_asset ON canvas_item (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX canvas_item_by_group ON canvas_item (group_id) WHERE group_id IS NOT NULL;

-- A link joins two anchors: an item, or one named element inside a diagram
-- item. It is not part of either item, so deleting either end deletes it.
-- The element is opaque here (the client reads names from the rendered
-- diagram); a name that is no longer in the source shows as a broken link.
CREATE TABLE canvas_link (
    id           TEXT PRIMARY KEY,
    canvas_id    TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    from_item    TEXT NOT NULL REFERENCES canvas_item (id) ON DELETE CASCADE,
    from_element TEXT CHECK (length(from_element) BETWEEN 1 AND 200),
    to_item      TEXT NOT NULL REFERENCES canvas_item (id) ON DELETE CASCADE,
    to_element   TEXT CHECK (length(to_element) BETWEEN 1 AND 200),
    link_type    TEXT NOT NULL CHECK (link_type IN ('describes', 'comments', 'implements', 'depends-on')),
    created_by   TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (from_item <> to_item OR coalesce(from_element, '') <> coalesce(to_element, ''))
);

CREATE INDEX canvas_link_by_canvas ON canvas_link (canvas_id);
CREATE INDEX canvas_link_by_from ON canvas_link (from_item);
CREATE INDEX canvas_link_by_to ON canvas_link (to_item);
