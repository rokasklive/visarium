-- The board's centerpiece (canvas/centerpiece): `item:<id>` or `group:<id>`,
-- framed when the board opens. NULL frames the whole board, as before.
ALTER TABLE canvas ADD COLUMN centerpiece TEXT;

-- A note's or checklist's text scale (canvas/text-scaling): its text is laid
-- out at width / text_scale and drawn at text_scale. NULL is 1.
ALTER TABLE canvas_item ADD COLUMN text_scale REAL CHECK (text_scale IS NULL OR (text_scale >= 0.25 AND text_scale <= 8));

-- Where a collision push took an item from (canvas/layout-settling): its
-- centre before the first push since it was last placed on purpose. NULL is
-- at home, which every existing row is.
ALTER TABLE canvas_item ADD COLUMN home_x REAL;
ALTER TABLE canvas_item ADD COLUMN home_y REAL;
