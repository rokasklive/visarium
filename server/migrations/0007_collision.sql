-- Collision (canvas/collision): on means the board pushes the item or group
-- aside when something overlaps it; off means it never moves. Off for every
-- existing row, so nothing on an existing board starts moving.
ALTER TABLE canvas_item ADD COLUMN collides INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canvas_group ADD COLUMN collides INTEGER NOT NULL DEFAULT 0;

-- Where a diagram's named elements are drawn, as a browser reported it for
-- revision `element_rev` (agents/placement): {"width": w, "elements": {name: [x, y, w, h]}}
-- in the layout's own units. Stale once the item's revision moves on.
ALTER TABLE canvas_item ADD COLUMN element_boxes TEXT CHECK (length(CAST(element_boxes AS BLOB)) <= 262144);
ALTER TABLE canvas_item ADD COLUMN element_rev INTEGER;
