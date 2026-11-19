//! Where to put something an agent adds or moves, without rendering it
//! (design D9): beside or inside a target, on the board's grid, overlapping
//! nothing. World space, rectangles by their centre as the schema stores them.

use crate::boards::ItemRow;

/// The board's grid (canvas-core `GRID_PITCH`): placements land on it.
pub const GRID: f64 = 24.0;
/// Space kept between a placed item and its neighbours.
const GAP: f64 = 24.0;
/// How far a search walks before giving up and stacking at the end.
const MAX_STEPS: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn of(i: &ItemRow) -> Rect {
        Rect {
            x: i.x,
            y: i.y,
            w: i.width,
            h: i.height,
        }
    }
    fn left(&self) -> f64 {
        self.x - self.w / 2.0
    }
    fn right(&self) -> f64 {
        self.x + self.w / 2.0
    }
    fn top(&self) -> f64 {
        self.y - self.h / 2.0
    }
    fn bottom(&self) -> f64 {
        self.y + self.h / 2.0
    }
    fn overlaps(&self, o: &Rect, gap: f64) -> bool {
        self.left() < o.right() + gap
            && o.left() < self.right() + gap
            && self.top() < o.bottom() + gap
            && o.top() < self.bottom() + gap
    }
    /// The box around several.
    pub fn around(rects: &[Rect]) -> Option<Rect> {
        let l = rects.iter().map(Rect::left).reduce(f64::min)?;
        let r = rects.iter().map(Rect::right).reduce(f64::max)?;
        let t = rects.iter().map(Rect::top).reduce(f64::min)?;
        let b = rects.iter().map(Rect::bottom).reduce(f64::max)?;
        Some(Rect {
            x: (l + r) / 2.0,
            y: (t + b) / 2.0,
            w: r - l,
            h: b - t,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Beside: right, else below, else left, else above, whichever is free nearest.
    Near,
    Below,
    RightOf,
    /// Inside a group: below its lowest member, within its width.
    In,
}

/// A new item's size before any client has laid it out: a guess the first
/// client to render it corrects (its height, with an ordinary transform).
pub fn estimate(kind: &str, source: &str, tasks: usize) -> (f64, f64) {
    match kind {
        "note" => {
            let lines: usize = source
                .lines()
                .map(|l| l.chars().count().div_ceil(40).max(1))
                .sum::<usize>()
                .max(1);
            (320.0, (40.0 + lines as f64 * 22.0).clamp(80.0, 1200.0))
        }
        "checklist" => (320.0, (56.0 + tasks as f64 * 28.0).clamp(80.0, 1600.0)),
        _ => (480.0, 360.0),
    }
}

fn snap(v: f64) -> f64 {
    (v / GRID).round() * GRID
}

/// The first free spot for a `size` box on `side` of `target`, walking away
/// from it along that side.
pub fn place(target: Rect, side: Side, size: (f64, f64), obstacles: &[Rect]) -> Rect {
    let (w, h) = size;
    let free = |r: &Rect| !obstacles.iter().any(|o| r.overlaps(o, GAP / 2.0));
    let walk = |start: Rect, dx: f64, dy: f64| -> Option<Rect> {
        (0..MAX_STEPS)
            .map(|k| Rect {
                x: snap(start.x + dx * k as f64),
                y: snap(start.y + dy * k as f64),
                w,
                h,
            })
            .find(|r| free(r))
    };
    let below = || {
        walk(
            Rect {
                x: target.left() + w / 2.0,
                y: target.bottom() + GAP + h / 2.0,
                w,
                h,
            },
            0.0,
            GRID,
        )
    };
    let right = || {
        walk(
            Rect {
                x: target.right() + GAP + w / 2.0,
                y: target.top() + h / 2.0,
                w,
                h,
            },
            GRID,
            0.0,
        )
    };
    let found = match side {
        Side::Below | Side::In => below(),
        Side::RightOf => right(),
        Side::Near => {
            // The first free spot in each direction, nearest wins.
            let left = walk(
                Rect {
                    x: target.left() - GAP - w / 2.0,
                    y: target.top() + h / 2.0,
                    w,
                    h,
                },
                -GRID,
                0.0,
            );
            let above = walk(
                Rect {
                    x: target.left() + w / 2.0,
                    y: target.top() - GAP - h / 2.0,
                    w,
                    h,
                },
                0.0,
                -GRID,
            );
            [right(), below(), left, above]
                .into_iter()
                .flatten()
                .min_by(|a, b| dist(a, &target).total_cmp(&dist(b, &target)))
        }
    };
    found.unwrap_or(Rect {
        x: snap(target.x),
        y: snap(target.bottom() + GAP + h / 2.0 + GRID * MAX_STEPS as f64),
        w,
        h,
    })
}

fn dist(a: &Rect, b: &Rect) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 480.0,
        h: 360.0,
    };

    #[test]
    fn below_skips_taken_space() {
        let taken = Rect {
            x: 0.0,
            y: 300.0,
            w: 480.0,
            h: 200.0,
        };
        let r = place(D, Side::Below, (320.0, 120.0), &[D, taken]);
        assert!(!r.overlaps(&taken, 0.0) && !r.overlaps(&D, 0.0));
        assert!(r.y > taken.y, "the nearest free space further down");
        assert_eq!(r.x % GRID, 0.0);
    }

    #[test]
    fn right_of_is_beside() {
        let r = place(D, Side::RightOf, (320.0, 120.0), &[D]);
        assert!(r.left() >= D.right() && (r.top() - D.top()).abs() <= GRID);
    }

    #[test]
    fn near_never_overlaps() {
        let crowd: Vec<Rect> = (0..20)
            .map(|i| Rect {
                x: 600.0 * (i % 5) as f64 - 1200.0,
                y: 500.0 * (i / 5) as f64 - 1000.0,
                w: 480.0,
                h: 360.0,
            })
            .collect();
        let mut all = crowd.clone();
        all.push(D);
        let r = place(D, Side::Near, (320.0, 200.0), &all);
        assert!(all.iter().all(|o| !r.overlaps(o, 0.0)));
    }
}
