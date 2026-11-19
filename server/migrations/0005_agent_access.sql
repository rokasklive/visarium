-- Agent access (ADR-0031): agent tokens, short refs, the operation log and
-- full-text search.

-- An agent token is a session of kind 'agent'. SQLite cannot change a CHECK
-- in place, so `session` is rebuilt; nothing references it.
CREATE TABLE session_next (
    token_hash   TEXT PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('browser', 'device', 'share', 'agent')),
    user_id      TEXT REFERENCES app_user (id) ON DELETE CASCADE,
    share_id     TEXT REFERENCES share_link (id) ON DELETE CASCADE,
    label        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    CHECK ((kind = 'share') = (share_id IS NOT NULL AND user_id IS NULL)),
    CHECK (kind = 'share' OR user_id IS NOT NULL)
);
INSERT INTO session_next SELECT token_hash, id, kind, user_id, share_id, label, created_at, last_seen_at, expires_at FROM session;
DROP TABLE session;
ALTER TABLE session_next RENAME TO session;
CREATE INDEX session_by_user ON session (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX session_by_share ON session (share_id) WHERE share_id IS NOT NULL;
CREATE INDEX session_by_expiry ON session (expires_at);

-- Short refs: `d2` is the board's second diagram, whatever else exists. One
-- counter per kind letter in `next_refs`, so a number is never handed out
-- twice on a board, even after its item is deleted. Existing items are
-- numbered per kind in the order they were made.
ALTER TABLE canvas ADD COLUMN next_refs TEXT NOT NULL DEFAULT '{}';
ALTER TABLE canvas_item ADD COLUMN ref_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canvas_group ADD COLUMN ref_no INTEGER NOT NULL DEFAULT 0;

UPDATE canvas_item SET ref_no = (
    SELECT n FROM (SELECT id, row_number() OVER (PARTITION BY canvas_id, kind ORDER BY created_at, id) AS n FROM canvas_item) r
     WHERE r.id = canvas_item.id
);
UPDATE canvas_group SET ref_no = (
    SELECT n FROM (SELECT id, row_number() OVER (PARTITION BY canvas_id ORDER BY rowid) AS n FROM canvas_group) r
     WHERE r.id = canvas_group.id
);
UPDATE canvas SET next_refs = json_object(
    'i', (SELECT coalesce(max(ref_no), 0) FROM canvas_item WHERE canvas_id = canvas.id AND kind = 'image'),
    'n', (SELECT coalesce(max(ref_no), 0) FROM canvas_item WHERE canvas_id = canvas.id AND kind = 'note'),
    'd', (SELECT coalesce(max(ref_no), 0) FROM canvas_item WHERE canvas_id = canvas.id AND kind = 'diagram'),
    'c', (SELECT coalesce(max(ref_no), 0) FROM canvas_item WHERE canvas_id = canvas.id AND kind = 'checklist'),
    'g', (SELECT coalesce(max(ref_no), 0) FROM canvas_group WHERE canvas_id = canvas.id)
);
CREATE UNIQUE INDEX canvas_item_by_ref ON canvas_item (canvas_id, kind, ref_no);
CREATE UNIQUE INDEX canvas_group_by_ref ON canvas_group (canvas_id, ref_no);

-- Which agent made a link, beside the person it acted for. Tasks carry the
-- same as `byAgent` inside the checklist's JSON.
ALTER TABLE canvas_link ADD COLUMN created_by_agent TEXT;

-- Every committed operation, in the transaction that applied it, so history
-- can never disagree with state. Trimmed to the newest few thousand per board.
CREATE TABLE canvas_operation (
    canvas_id   TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
    revision    INTEGER NOT NULL,
    actor_id    TEXT REFERENCES app_user (id) ON DELETE SET NULL,
    actor_agent TEXT,
    at          TEXT NOT NULL,
    body        TEXT NOT NULL,
    PRIMARY KEY (canvas_id, revision)
);

-- An agent's write, remembered by its request id for a day, so a retry after
-- a timeout returns the first answer instead of applying the change twice.
CREATE TABLE agent_request (
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    result     TEXT NOT NULL,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (session_id, request_id)
);

-- Full-text search over what items say. `_` and `-` are part of a word, so
-- `retry_policy` and `depends-on` are found whole.
CREATE VIRTUAL TABLE item_text USING fts5(
    text, canvas_id UNINDEXED, item_id UNINDEXED,
    tokenize = "unicode61 tokenchars '_-'"
);
INSERT INTO item_text (text, canvas_id, item_id)
SELECT CASE kind
         WHEN 'checklist' THEN coalesce(json_extract(body, '$.title'), '') || char(10) ||
              coalesce((SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(body, '$.tasks')), '')
         ELSE body
       END,
       canvas_id, id
  FROM canvas_item WHERE kind <> 'image';
