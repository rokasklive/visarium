-- Non-destructive crop (ADR-0029): the window on the original an item shows,
-- as fractions of the original, in source orientation. All four NULL means the
-- whole image, which is every row that exists today: no backfill.
--
-- The one CHECK sits on the last column because SQLite cannot add a table-level
-- constraint with ALTER; a column CHECK may still name its siblings. 1e-9 is the
-- float tolerance the request boundary also allows and then clamps away.
--
-- ponytail: SQLite re-checks a column CHECK on UPDATE only when that column is
-- written, so an UPDATE of crop_x alone would slip past. Every writer
-- (boards.rs: item.create, item.transform, duplicate) sets all four together and
-- `check_crop` validates first. A trigger closes the gap if a writer ever doesn't.
ALTER TABLE canvas_item ADD COLUMN crop_x REAL;
ALTER TABLE canvas_item ADD COLUMN crop_y REAL;
ALTER TABLE canvas_item ADD COLUMN crop_w REAL;
ALTER TABLE canvas_item ADD COLUMN crop_h REAL CHECK (
    (crop_x IS NULL AND crop_y IS NULL AND crop_w IS NULL AND crop_h IS NULL)
    OR (crop_x >= 0 AND crop_y >= 0 AND crop_w > 0 AND crop_h > 0
        AND crop_x + crop_w <= 1.000000001 AND crop_y + crop_h <= 1.000000001)
);
