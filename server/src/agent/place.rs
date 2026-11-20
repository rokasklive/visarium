//! Where to put something an agent adds or moves, without rendering it
//! (design D9): beside or inside a target, on the board's grid, overlapping
//! nothing. World space, rectangles by their centre as the schema stores them.

use crate::boards::ItemRow;

/// The board's grid (canvas-core `GRID_PITCH`): placements land on it.
pub const GRID: f64 = 24.0;
/// Space kept between a placed item and its neighbours.
pub const GAP: f64 = 24.0;
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
    pub fn left(&self) -> f64 {
        self.x - self.w / 2.0
    }
    pub fn right(&self) -> f64 {
        self.x + self.w / 2.0
    }
    pub fn top(&self) -> f64 {
        self.y - self.h / 2.0
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h / 2.0
    }
    pub fn overlaps(&self, o: &Rect, gap: f64) -> bool {
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

/// Where an anchor is in world space: one element's drawn box when a browser
/// reported it for the item's current revision (agents/placement), else the
/// whole item. Scaled the way the browser's `anchorBox` scales it.
///
/// ponytail: a rotated diagram answers with the whole item; rotate the box
/// about the centre if rotated diagrams get linked to.
pub fn anchor_box(i: &ItemRow, element: Option<&str>) -> Rect {
    let whole = Rect::of(i);
    let (Some(name), Some(boxes), Some(rev)) = (element, i.element_boxes.as_deref(), i.element_rev)
    else {
        return whole;
    };
    if rev != i.revision || i.rotation != 0.0 {
        return whole;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(boxes) else {
        return whole;
    };
    let (Some(width), Some(r)) = (
        v["width"].as_f64().filter(|w| *w > 0.0),
        v["elements"][name].as_array(),
    ) else {
        return whole;
    };
    let n: Vec<f64> = r.iter().filter_map(|x| x.as_f64()).collect();
    let [x, y, w, h] = n[..] else { return whole };
    let k = i.width / width;
    Rect {
        x: whole.left() + (x + w / 2.0) * k,
        y: whole.top() + (y + h / 2.0) * k,
        w: w * k,
        h: h * k,
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

/// Onto the board's grid.
pub fn snap(v: f64) -> f64 {
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

/// A crossing costs as much as this much extra link length.
const W_CROSS: f64 = 400.0;
/// Pull toward the named `near`/`below`/`right_of` target, per unit of distance.
const W_NEAR: f64 = 0.25;
/// Pull toward the target group's outline, per unit of distance outside it.
const W_GROUP: f64 = 1.0;
/// How far around an anchor candidates are tried, in grid steps per side.
const SLIDE_STEPS: i32 = 24;

pub type Pt = (f64, f64);
pub type Segment = (Pt, Pt);

/// One link a box will have: where its other end is, and the item that end
/// belongs to (which its line may end inside without crossing it).
#[derive(Clone, Copy, Debug)]
pub struct LinkEnd {
    pub anchor: Rect,
    pub owner: Rect,
}

/// What a placement keeps clear of and keeps short.
pub struct Scene<'a> {
    /// Items and group outlines nothing may overlap.
    pub obstacles: &'a [Rect],
    /// Items a new line may cross, at a cost: every item on the board.
    pub items: &'a [Rect],
    /// Existing links with at least one collision-on end.
    pub segments: &'a [Segment],
    /// The group the box goes near, if any.
    pub group: Option<Rect>,
}

/// A link as the browser draws it (canvas/link-geometry): between the two
/// boxes' nearest points. Per axis, overlapping extents meet in the middle of
/// the overlap; otherwise each end is its box's facing edge. The browser's
/// `nearestPoints`, without its few screen pixels of padding.
pub fn segment(a: &Rect, b: &Rect) -> Segment {
    let axis = |a0: f64, a1: f64, b0: f64, b1: f64| {
        let (lo, hi) = (a0.max(b0), a1.min(b1));
        if lo <= hi {
            ((lo + hi) / 2.0, (lo + hi) / 2.0)
        } else if a1 < b0 {
            (a1, b0)
        } else {
            (a0, b1)
        }
    };
    let (ax, bx) = axis(a.left(), a.right(), b.left(), b.right());
    let (ay, by) = axis(a.top(), a.bottom(), b.top(), b.bottom());
    ((ax, ay), (bx, by))
}

pub fn length(s: &Segment) -> f64 {
    ((s.1.0 - s.0.0).powi(2) + (s.1.1 - s.0.1).powi(2)).sqrt()
}

/// Whether a segment passes through a rectangle's interior (Liang–Barsky).
pub fn hits(s: &Segment, r: &Rect) -> bool {
    let (x0, y0, dx, dy) = (s.0.0, s.0.1, s.1.0 - s.0.0, s.1.1 - s.0.1);
    let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
    for (p, q) in [
        (-dx, x0 - r.left()),
        (dx, r.right() - x0),
        (-dy, y0 - r.top()),
        (dy, r.bottom() - y0),
    ] {
        if p == 0.0 {
            if q <= 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 >= t1 {
                return false;
            }
        }
    }
    // Touching an edge is not passing through.
    t1 - t0 > 1e-6
}

/// Whether two segments cross (sharing an endpoint does not count).
pub fn crosses(a: &Segment, b: &Segment) -> bool {
    let o = |p: Pt, q: Pt, r: Pt| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    let (d1, d2) = (o(b.0, b.1, a.0), o(b.0, b.1, a.1));
    let (d3, d4) = (o(a.0, a.1, b.0), o(a.0, a.1, b.1));
    (d1 * d2 < 0.0) && (d3 * d4 < 0.0)
}

/// Shortest distance between two boxes, edge to edge; 0 when they touch.
pub fn gap_between(a: &Rect, b: &Rect) -> f64 {
    let dx = (a.left() - b.right()).max(b.left() - a.right()).max(0.0);
    let dy = (a.top() - b.bottom()).max(b.top() - a.bottom()).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

/// How many things a new link from `at` to `end` passes through or over.
pub fn crossings(scene: &Scene, at: &Rect, end: &LinkEnd) -> usize {
    let s = segment(at, &end.anchor);
    let through = scene
        .items
        .iter()
        .filter(|r| **r != end.owner && *r != at && hits(&s, r))
        .count();
    through + scene.segments.iter().filter(|o| crosses(&s, o)).count()
}

/// The box for something with links: the free spot whose links are shortest
/// and cross least, staying near the named target and group (design D2).
/// Without links it is exactly [`place`]. `below` and `right_of` are kept:
/// the links choose only where along that side; `near` lets them pick any.
pub fn place_linked(
    target: Rect,
    side: Side,
    size: (f64, f64),
    scene: &Scene,
    links: &[LinkEnd],
) -> Rect {
    if links.is_empty() || side == Side::In {
        return place(target, side, size, scene.obstacles);
    }
    let (w, h) = size;
    let free = |r: &Rect| !scene.obstacles.iter().any(|o| r.overlaps(o, GAP / 2.0));
    let mut candidates: Vec<Rect> = vec![];
    for a in std::iter::once(target).chain(links.iter().map(|l| l.anchor)) {
        for k in -SLIDE_STEPS..=SLIDE_STEPS {
            let along = k as f64 * GRID;
            for (x, y) in [
                (a.right() + GAP + w / 2.0, a.y + along),
                (a.x + along, a.bottom() + GAP + h / 2.0),
                (a.left() - GAP - w / 2.0, a.y + along),
                (a.x + along, a.top() - GAP - h / 2.0),
            ] {
                candidates.push(Rect {
                    x: snap(x),
                    y: snap(y),
                    w,
                    h,
                });
            }
        }
        // The outward walks reach past whatever crowds the anchor.
        for s in [Side::RightOf, Side::Below, Side::Near] {
            candidates.push(place(a, s, size, scene.obstacles));
        }
    }
    let cost = |c: &Rect| {
        let mut total = W_NEAR * gap_between(c, &target);
        for l in links {
            total += length(&segment(c, &l.anchor)) + W_CROSS * crossings(scene, c, l) as f64;
        }
        if let Some(g) = scene.group {
            total += W_GROUP * gap_between(c, &g);
        }
        total
    };
    let kept = |c: &Rect| match side {
        Side::Below => c.top() >= target.bottom(),
        Side::RightOf => c.left() >= target.right(),
        _ => true,
    };
    candidates
        .into_iter()
        .filter(|c| free(c) && kept(c))
        .map(|c| (cost(&c), c))
        .min_by(|(a, p), (b, q)| {
            a.total_cmp(b)
                .then(p.y.total_cmp(&q.y))
                .then(p.x.total_cmp(&q.x))
        })
        .map(|(_, c)| c)
        .unwrap_or_else(|| place(target, side, size, scene.obstacles))
}

/// How [`pack`] lines boxes up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pack {
    Row,
    Column,
    Grid(usize),
}

/// Boxes, in the order given, packed row-major into a block (design D6):
/// columns as wide as their widest box, rows as tall as their tallest, each
/// box at its cell's top left, `gap` between. Returns each box's centre as an
/// offset from the block's top left, and the block's size.
pub fn pack(sizes: &[(f64, f64)], how: Pack, gap: f64) -> (Vec<(f64, f64)>, (f64, f64)) {
    let n = sizes.len();
    let cols = match how {
        Pack::Row => n,
        Pack::Column => 1,
        Pack::Grid(c) => c,
    }
    .clamp(1, n.max(1));
    let rows = n.div_ceil(cols);
    let col_w: Vec<f64> = (0..cols)
        .map(|c| (c..n).step_by(cols).map(|i| sizes[i].0).fold(0.0, f64::max))
        .collect();
    let row_h: Vec<f64> = (0..rows)
        .map(|r| {
            (r * cols..((r + 1) * cols).min(n))
                .map(|i| sizes[i].1)
                .fold(0.0, f64::max)
        })
        .collect();
    let starts = |spans: &[f64]| -> Vec<f64> {
        spans
            .iter()
            .scan(0.0, |at, s| {
                let here = *at;
                *at += s + gap;
                Some(here)
            })
            .collect()
    };
    let (x0, y0) = (starts(&col_w), starts(&row_h));
    let offsets = (0..n)
        .map(|i| {
            (
                x0[i % cols] + sizes[i].0 / 2.0,
                y0[i / cols] + sizes[i].1 / 2.0,
            )
        })
        .collect();
    let total =
        |spans: &[f64]| spans.iter().sum::<f64>() + gap * (spans.len().saturating_sub(1)) as f64;
    (offsets, (total(&col_w), total(&row_h)))
}

/// Which side of `target` a placed box ended up on, in words.
pub fn side_of(spot: &Rect, target: &Rect) -> &'static str {
    if spot.left() >= target.right() {
        "right of"
    } else if spot.top() >= target.bottom() {
        "below"
    } else if spot.right() <= target.left() {
        "left of"
    } else if spot.bottom() <= target.top() {
        "above"
    } else {
        "beside"
    }
}

fn dist(a: &Rect, b: &Rect) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagram(boxes: Option<&str>, element_rev: Option<i64>, revision: i64) -> ItemRow {
        ItemRow {
            id: "d".into(),
            kind: "diagram".into(),
            lang: Some("mermaid".into()),
            body: Some(String::new()),
            revision,
            group_id: None,
            x: 0.0,
            y: 0.0,
            width: 480.0,
            height: 200.0,
            rotation: 0.0,
            z: 0.0,
            opacity: 1.0,
            flip_x: false,
            flip_y: false,
            crop_x: None,
            crop_y: None,
            crop_w: None,
            crop_h: None,
            asset_id: None,
            intrinsic_width: None,
            intrinsic_height: None,
            mime_type: None,
            ref_no: 1,
            collides: true,
            text_scale: None,
            home_x: None,
            home_y: None,
            element_boxes: boxes.map(str::to_string),
            element_rev,
        }
    }

    const BOXES: &str = r#"{"width": 240, "elements": {"Connect": [200, 40, 40, 20]}}"#;

    #[test]
    fn an_element_reported_for_the_current_revision_is_where_it_was_drawn() {
        // Laid out 240 wide, drawn 480 wide: twice the size, from the top left.
        let r = anchor_box(&diagram(Some(BOXES), Some(3), 3), Some("Connect"));
        assert_eq!(
            r,
            Rect {
                x: -240.0 + 440.0,
                y: -100.0 + 100.0,
                w: 80.0,
                h: 40.0
            }
        );
    }

    #[test]
    fn a_missing_stale_or_unnamed_element_is_the_whole_item() {
        let whole = Rect {
            x: 0.0,
            y: 0.0,
            w: 480.0,
            h: 200.0,
        };
        assert_eq!(
            anchor_box(&diagram(Some(BOXES), Some(2), 3), Some("Connect")),
            whole,
            "stale"
        );
        assert_eq!(
            anchor_box(&diagram(Some(BOXES), Some(3), 3), Some("Nope")),
            whole,
            "unknown name"
        );
        assert_eq!(
            anchor_box(&diagram(None, None, 3), Some("Connect")),
            whole,
            "never reported"
        );
        assert_eq!(
            anchor_box(&diagram(Some(BOXES), Some(3), 3), None),
            whole,
            "the item itself"
        );
    }

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

    fn scene<'a>(obstacles: &'a [Rect], segments: &'a [Segment]) -> Scene<'a> {
        Scene {
            obstacles,
            items: obstacles,
            segments,
            group: None,
        }
    }

    #[test]
    fn a_note_linked_to_an_element_sits_beside_that_element() {
        // Connect is drawn at d's right edge.
        let connect = Rect {
            x: 200.0,
            y: 60.0,
            w: 60.0,
            h: 40.0,
        };
        let end = LinkEnd {
            anchor: connect,
            owner: D,
        };
        let r = place_linked(D, Side::Near, (320.0, 120.0), &scene(&[D], &[]), &[end]);
        assert!(r.left() >= D.right(), "right of d, where Connect is: {r:?}");
        // Beside it: their extents overlap, so the link runs straight across.
        assert!(
            r.top() < connect.bottom() && connect.top() < r.bottom(),
            "level with Connect: {r:?}"
        );
        let (from, to) = segment(&r, &connect);
        assert_eq!(from.1, to.1, "a straight link: {from:?} {to:?}");
    }

    #[test]
    fn below_stays_below_whatever_the_link_prefers() {
        let left = Rect {
            x: -900.0,
            y: 0.0,
            w: 200.0,
            h: 200.0,
        };
        let end = LinkEnd {
            anchor: left,
            owner: left,
        };
        let r = place_linked(
            D,
            Side::Below,
            (320.0, 120.0),
            &scene(&[D, left], &[]),
            &[end],
        );
        assert!(r.top() >= D.bottom(), "{r:?}");
        assert!(r.x < 0.0, "but slid toward the link: {r:?}");
    }

    #[test]
    fn a_link_far_from_near_wins_over_near() {
        let far = Rect {
            x: 4000.0,
            y: 0.0,
            w: 480.0,
            h: 360.0,
        };
        let end = LinkEnd {
            anchor: far,
            owner: far,
        };
        let r = place_linked(
            D,
            Side::Near,
            (320.0, 120.0),
            &scene(&[D, far], &[]),
            &[end],
        );
        assert!(
            gap_between(&r, &far) < gap_between(&r, &D),
            "placed by its link: {r:?}"
        );
    }

    #[test]
    fn of_two_equal_spots_the_one_without_a_crossing_wins() {
        // A target with free space left and right; a note sits between the
        // target and the right-hand spot's line to the linked element.
        let target = Rect {
            x: 0.0,
            y: 0.0,
            w: 200.0,
            h: 200.0,
        };
        let linked = Rect {
            x: 0.0,
            y: -800.0,
            w: 200.0,
            h: 100.0,
        };
        let blocker = Rect {
            x: 360.0,
            y: -400.0,
            w: 200.0,
            h: 200.0,
        };
        let all = [target, linked, blocker];
        let end = LinkEnd {
            anchor: linked,
            owner: linked,
        };
        let r = place_linked(
            target,
            Side::Near,
            (200.0, 100.0),
            &scene(&all, &[]),
            &[end],
        );
        assert_eq!(crossings(&scene(&all, &[]), &r, &end), 0, "{r:?}");
    }

    #[test]
    fn links_between_fixed_items_are_not_in_the_way() {
        // The same scene with and without a segment the caller left out
        // because both its ends have collision off: no segment, no cost.
        let linked = Rect {
            x: 0.0,
            y: -800.0,
            w: 200.0,
            h: 100.0,
        };
        let end = LinkEnd {
            anchor: linked,
            owner: linked,
        };
        let without = place_linked(
            D,
            Side::Near,
            (200.0, 100.0),
            &scene(&[D, linked], &[]),
            &[end],
        );
        // Square across the middle of the chosen link.
        let ((x0, y0), (x1, y1)) = segment(&without, &linked);
        let (mx, my, dx, dy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, x1 - x0, y1 - y0);
        let crossing: Segment = ((mx - dy, my + dx), (mx + dy, my - dx));
        let with = place_linked(
            D,
            Side::Near,
            (200.0, 100.0),
            &scene(&[D, linked], &[crossing]),
            &[end],
        );
        assert_ne!(without, with, "a counted segment moves the spot");
    }

    #[test]
    fn a_grid_packs_row_major_top_aligned_with_an_even_gap() {
        let sizes = [(100.0, 50.0), (200.0, 80.0), (100.0, 50.0), (100.0, 60.0)];
        let (at, block) = pack(&sizes, Pack::Grid(3), 24.0);
        // Row one: three across, tops at 0; row two starts below the tallest.
        assert_eq!(at[0], (50.0, 25.0));
        assert_eq!(at[1], (124.0 + 100.0, 40.0));
        assert_eq!(at[2], (124.0 + 224.0 + 50.0, 25.0));
        assert_eq!(at[3], (50.0, 80.0 + 24.0 + 30.0));
        assert_eq!(block, (100.0 + 200.0 + 100.0 + 48.0, 80.0 + 24.0 + 60.0));
        assert_eq!(pack(&sizes, Pack::Column, 0.0).1, (200.0, 240.0));
        assert_eq!(pack(&sizes, Pack::Row, 0.0).1, (500.0, 80.0));
    }

    #[test]
    fn segment_geometry() {
        let a = Rect {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
        };
        let b = Rect {
            x: 300.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
        };
        let s = segment(&a, &b);
        assert_eq!(s, ((50.0, 0.0), (250.0, 0.0)));
        assert_eq!(length(&s), 200.0);
        assert!(hits(
            &s,
            &Rect {
                x: 150.0,
                y: 0.0,
                w: 20.0,
                h: 20.0
            }
        ));
        assert!(!hits(
            &s,
            &Rect {
                x: 150.0,
                y: 100.0,
                w: 20.0,
                h: 20.0
            }
        ));
        assert!(crosses(&s, &((150.0, -50.0), (150.0, 50.0))));
        assert!(!crosses(&s, &((150.0, 10.0), (150.0, 50.0))));
        assert_eq!(side_of(&b, &a), "right of");
    }

    #[test]
    fn a_link_to_a_lifeline_lands_on_its_head() {
        // A note up and to the left of a tall, thin lifeline whose x it overlaps.
        let note = Rect {
            x: 300.0,
            y: -200.0,
            w: 400.0,
            h: 120.0,
        };
        let lifeline = Rect {
            x: 420.0,
            y: 400.0,
            w: 20.0,
            h: 800.0,
        };
        let (from, to) = segment(&note, &lifeline);
        assert_eq!(to, (420.0, 0.0), "the top of the lifeline, straight below");
        assert_eq!(from, (420.0, -140.0));
        // Diagonal: corner to corner.
        let far = Rect {
            x: 1000.0,
            y: 1000.0,
            w: 100.0,
            h: 100.0,
        };
        assert_eq!(segment(&note, &far), ((500.0, -140.0), (950.0, 950.0)));
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
