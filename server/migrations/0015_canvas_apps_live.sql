-- Canvas apps, live (openspec canvas-apps-live). Additive: no table is rebuilt.
--
--  * A `feeds` link may name the input the app sees (default `<ref>.<view>`)
--    and narrow its view to one field (`frontmatter.age`). Only `feeds` links
--    carry either.
--  * An output version may carry a card: a snapshot of the view as it drew
--    that version, with no scripts and nothing from outside (canvas/apps).
--  * An automatic run records what caused it: { auto, by, item }.
--
-- An app's literals, run mode and source/setup counters live in its JSON body.

ALTER TABLE canvas_link ADD COLUMN name TEXT
    CHECK (name IS NULL OR (link_type = 'feeds' AND length(name) BETWEEN 1 AND 64));
ALTER TABLE canvas_link ADD COLUMN path TEXT
    CHECK (path IS NULL OR (link_type = 'feeds' AND length(path) BETWEEN 1 AND 200));

ALTER TABLE app_output ADD COLUMN card TEXT
    CHECK (card IS NULL OR length(CAST(card AS BLOB)) <= 65536);
ALTER TABLE app_output ADD COLUMN cause TEXT
    CHECK (cause IS NULL OR json_type(cause) = 'object');
