//! Pushing collision-on items aside (canvas/collision, design D3).
//!
//! A pure function of the board's geometry: which items moved in a batch
//! (the causes), and where everything is. It answers with how far to move
//! each collision-on item that a cause now overlaps. No simulation and no
//! re-layout: only overlapped items move, the shortest way out, and a cause
//! always stays where it was put.
//!
//! Then the way back (canvas/layout-settling): an item a push took away from
//! where it was deliberately put (its home) moves back toward it as far as
//! free space allows, so layouts do not drift apart as things grow and shrink.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::agent::place::{self, GAP, GRID, Rect, Side};

/// Moves one batch may make. A push stops here, overlaps or not.
pub const MAX_PUSHES: usize = 64;
/// How far a group's outline stands off its members, as outsiders see it:
/// the drawn frame's half-cell margin, snapped up to the grid.
pub const GROUP_PAD: f64 = GRID;

/// Bounds of a stored transform, rotation (radians) included.
pub fn bounds(x: f64, y: f64, w: f64, h: f64, rotation: f64) -> Rect {
    let (c, s) = (rotation.cos().abs(), rotation.sin().abs());
    Rect {
        x,
        y,
        w: w * c + h * s,
        h: w * s + h * c,
    }
}

/// One item as the solver sees it.
#[derive(Clone, Debug)]
pub struct Piece {
    pub id: String,
    pub rect: Rect,
    pub group: Option<String>,
    pub collides: bool,
    /// The centre it was deliberately put at, when a push has moved it since.
    pub home: Option<(f64, f64)>,
}

#[derive(Clone, Debug)]
struct Body {
    rect: Rect,
    moving: bool,
}

/// Rounds a distance away from zero onto the grid, so a moved item stays on
/// the same grid lines and still clears what pushed it.
fn snap_out(d: f64) -> f64 {
    d.signum() * (d.abs() / GRID).ceil() * GRID
}

fn shifted(r: Rect, (dx, dy): (f64, f64)) -> Rect {
    Rect {
        x: r.x + dx,
        y: r.y + dy,
        ..r
    }
}

/// Moves for every moving body a cause overlaps, breadth-first. Causes, and
/// bodies once moved, are pinned: nothing pushes them back.
fn push(bodies: &[Body], causes: &[usize]) -> HashMap<usize, (f64, f64)> {
    let mut rects: Vec<Rect> = bodies.iter().map(|b| b.rect).collect();
    let mut pinned: HashSet<usize> = causes.iter().copied().collect();
    let mut queue: VecDeque<usize> = causes.iter().copied().collect();
    let mut moved: HashMap<usize, (f64, f64)> = HashMap::new();
    let mut pushes = 0;
    while let Some(c) = queue.pop_front() {
        for j in 0..bodies.len() {
            if j == c
                || pinned.contains(&j)
                || !bodies[j].moving
                || !rects[c].overlaps(&rects[j], 0.0)
            {
                continue;
            }
            if pushes == MAX_PUSHES {
                return moved;
            }
            let blocked = |r: &Rect| {
                (0..bodies.len()).any(|k| {
                    k != j
                        && (pinned.contains(&k) || !bodies[k].moving)
                        && r.overlaps(&rects[k], 0.0)
                })
            };
            let (a, b) = (rects[c], rects[j]);
            // Down, right, up, left: the tie order (reading order).
            let mut options = [
                (0.0, a.bottom() + GAP - b.top()),
                (a.right() + GAP - b.left(), 0.0),
                (0.0, a.top() - GAP - b.bottom()),
                (a.left() - GAP - b.right(), 0.0),
            ]
            .map(|(dx, dy)| (snap_out(dx), snap_out(dy)));
            options.sort_by(|p, q| (p.0.abs() + p.1.abs()).total_cmp(&(q.0.abs() + q.1.abs())));
            let delta = options
                .into_iter()
                .find(|d| !blocked(&shifted(b, *d)))
                .unwrap_or_else(|| {
                    // Boxed in by things that do not move: the nearest free space.
                    let others: Vec<Rect> = (0..bodies.len())
                        .filter(|k| *k != j)
                        .map(|k| rects[k])
                        .collect();
                    let spot = place::place(b, Side::Near, (b.w, b.h), &others);
                    (spot.x - b.x, spot.y - b.y)
                });
            rects[j] = shifted(b, delta);
            let m = moved.entry(j).or_default();
            *m = (m.0 + delta.0, m.1 + delta.1);
            pinned.insert(j);
            queue.push_back(j);
            pushes += 1;
        }
    }
    moved
}

/// Moves back toward home for bodies a push took away and that did not move
/// in this batch, nearest-to-home first so one return does not block another.
/// All the way home when that is free (home was a fine place once); else the
/// furthest grid step along the way that keeps a gap from everything.
fn ret(
    bodies: &[Body],
    homes: &[Option<(f64, f64)>],
    fixed: &HashSet<usize>,
) -> HashMap<usize, (f64, f64)> {
    let mut rects: Vec<Rect> = bodies.iter().map(|b| b.rect).collect();
    let mut order: Vec<(usize, (f64, f64))> = (0..bodies.len())
        .filter(|j| bodies[*j].moving && !fixed.contains(j))
        .filter_map(|j| {
            homes[j]
                .filter(|(dx, dy)| dx.abs() >= 0.5 || dy.abs() >= 0.5)
                .map(|d| (j, d))
        })
        .collect();
    order.sort_by(|a, b| a.1.0.hypot(a.1.1).total_cmp(&b.1.0.hypot(b.1.1)));
    let mut moved = HashMap::new();
    for (j, (dx, dy)) in order {
        let free =
            |r: &Rect, gap: f64| !(0..bodies.len()).any(|k| k != j && r.overlaps(&rects[k], gap));
        let steps = (dx.abs().max(dy.abs()) / GRID).ceil().max(1.0) as usize;
        let snap = |v: f64| (v / GRID).round() * GRID;
        let found = (1..=steps).rev().find_map(|k| {
            let d = if k == steps {
                (dx, dy)
            } else {
                (
                    snap(dx * k as f64 / steps as f64),
                    snap(dy * k as f64 / steps as f64),
                )
            };
            let gap = if k == steps { 0.0 } else { GAP };
            (d != (0.0, 0.0) && free(&shifted(rects[j], d), gap)).then_some(d)
        });
        if let Some(d) = found {
            rects[j] = shifted(rects[j], d);
            moved.insert(j, d);
        }
    }
    moved
}

/// The offset back to a piece's home, if a push has taken it away.
fn home_offset(p: &Piece) -> Option<(f64, f64)> {
    p.home.map(|(hx, hy)| (hx - p.rect.x, hy - p.rect.y))
}

/// One offset for a set moved as one (a group pushed whole): every member
/// shares it, or there is none.
fn shared_offset(pieces: &[Piece], members: &[usize]) -> Option<(f64, f64)> {
    let first = home_offset(&pieces[*members.first()?])?;
    members
        .iter()
        .all(|i| {
            home_offset(&pieces[*i])
                .is_some_and(|o| (o.0 - first.0).abs() < 0.5 && (o.1 - first.1).abs() < 0.5)
        })
        .then_some(first)
}

fn padded(r: Rect) -> Rect {
    Rect {
        w: r.w + 2.0 * GROUP_PAD,
        h: r.h + 2.0 * GROUP_PAD,
        ..r
    }
}

/// How far each item must move, given the items and groups on a board, each
/// group's collision setting, and the ids (item or group) a batch changed.
/// Items not listed stay put.
pub fn settle(
    pieces: &[Piece],
    groups: &HashMap<String, bool>,
    causes: &HashSet<String>,
) -> Vec<(String, f64, f64)> {
    let mut delta: HashMap<usize, (f64, f64)> = HashMap::new();
    let member_of = |i: usize| pieces[i].group.as_ref().filter(|g| groups.contains_key(*g));

    // Inside each collision-on group that holds a cause: members push members.
    let mut ids: Vec<&String> = groups.keys().collect();
    ids.sort();
    for g in ids {
        if !groups[g] {
            continue;
        }
        let members: Vec<usize> = (0..pieces.len())
            .filter(|i| member_of(*i) == Some(g))
            .collect();
        let cause: Vec<usize> = (0..members.len())
            .filter(|m| causes.contains(&pieces[members[*m]].id))
            .collect();
        if cause.is_empty() {
            continue;
        }
        let bodies: Vec<Body> = members
            .iter()
            .map(|i| Body {
                rect: pieces[*i].rect,
                moving: true,
            })
            .collect();
        for (m, d) in push(&bodies, &cause) {
            delta.insert(members[m], d);
        }
    }

    // Inside each collision-on group, members pushed apart by members find
    // their way back. A group pushed whole goes back whole, at the top level.
    // ponytail: a member pushed both inside and with its group mixes the two
    // offsets and returns on its own; split home into group and member parts
    // if that ever shows.
    let mut ids: Vec<&String> = groups.keys().collect();
    ids.sort();
    for g in ids {
        let members: Vec<usize> = (0..pieces.len())
            .filter(|i| member_of(*i) == Some(g))
            .collect();
        if !groups[g] || shared_offset(pieces, &members).is_some() {
            continue;
        }
        let bodies: Vec<Body> = members
            .iter()
            .map(|i| Body {
                rect: shifted(pieces[*i].rect, delta.get(i).copied().unwrap_or_default()),
                moving: true,
            })
            .collect();
        let homes: Vec<_> = members.iter().map(|i| home_offset(&pieces[*i])).collect();
        let fixed: HashSet<usize> = (0..members.len())
            .filter(|m| {
                causes.contains(&pieces[members[*m]].id) || delta.contains_key(&members[*m])
            })
            .collect();
        for (m, d) in ret(&bodies, &homes, &fixed) {
            delta.insert(members[m], d);
        }
    }

    // The top level: loose items, and each group as one body.
    let rect = |i: usize| shifted(pieces[i].rect, delta.get(&i).copied().unwrap_or_default());
    let mut bodies = Vec::new();
    let mut owners: Vec<Vec<usize>> = Vec::new();
    let mut cause = Vec::new();
    let mut group_ids: Vec<&String> = groups.keys().collect();
    group_ids.sort();
    for g in group_ids {
        let members: Vec<usize> = (0..pieces.len())
            .filter(|i| member_of(*i) == Some(g))
            .collect();
        let Some(around) = Rect::around(&members.iter().map(|i| rect(*i)).collect::<Vec<_>>())
        else {
            continue;
        };
        if causes.contains(g) || members.iter().any(|i| causes.contains(&pieces[*i].id)) {
            cause.push(bodies.len());
        }
        bodies.push(Body {
            rect: padded(around),
            moving: groups[g],
        });
        owners.push(members);
    }
    for i in (0..pieces.len()).filter(|i| member_of(*i).is_none()) {
        if causes.contains(&pieces[i].id) {
            cause.push(bodies.len());
        }
        bodies.push(Body {
            rect: rect(i),
            moving: pieces[i].collides,
        });
        owners.push(vec![i]);
    }
    let pushed = push(&bodies, &cause);
    for (b, (dx, dy)) in &pushed {
        for i in &owners[*b] {
            let d = delta.entry(*i).or_default();
            *d = (d.0 + dx, d.1 + dy);
        }
    }

    // The way back, for loose items and whole groups.
    let now: Vec<Body> = bodies
        .iter()
        .enumerate()
        .map(|(b, body)| Body {
            rect: shifted(body.rect, pushed.get(&b).copied().unwrap_or_default()),
            moving: body.moving,
        })
        .collect();
    let homes: Vec<_> = owners
        .iter()
        .map(|o| {
            if o.len() == 1 && member_of(o[0]).is_none() {
                home_offset(&pieces[o[0]])
            } else {
                shared_offset(pieces, o)
            }
        })
        .collect();
    let mut fixed: HashSet<usize> = cause.iter().copied().collect();
    fixed.extend(pushed.keys().copied());
    for (b, (dx, dy)) in ret(&now, &homes, &fixed) {
        for i in &owners[b] {
            let d = delta.entry(*i).or_default();
            *d = (d.0 + dx, d.1 + dy);
        }
    }

    let mut out: Vec<(String, f64, f64)> = delta
        .into_iter()
        .filter(|(_, d)| *d != (0.0, 0.0))
        .map(|(i, (dx, dy))| (pieces[i].id.clone(), dx, dy))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(id: &str, x: f64, y: f64, w: f64, h: f64, collides: bool) -> Piece {
        Piece {
            id: id.into(),
            rect: Rect { x, y, w, h },
            group: None,
            collides,
            home: None,
        }
    }

    fn moved(out: &[(String, f64, f64)], id: &str) -> Option<(f64, f64)> {
        out.iter().find(|m| m.0 == id).map(|m| (m.1, m.2))
    }

    fn after(p: &[Piece], out: &[(String, f64, f64)]) -> Vec<Rect> {
        p.iter()
            .map(|q| shifted(q.rect, moved(out, &q.id).unwrap_or_default()))
            .collect()
    }

    fn causes(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rotated_bounds_swap_a_quarter_turn() {
        let r = bounds(0.0, 0.0, 200.0, 100.0, std::f64::consts::FRAC_PI_2);
        assert!((r.w - 100.0).abs() < 1e-9 && (r.h - 200.0).abs() < 1e-9);
    }

    #[test]
    fn a_grown_checklist_pushes_the_note_below_down() {
        // The checklist grew from 200 to 300 tall and now overlaps the note.
        let p = [
            piece("c", 0.0, 0.0, 320.0, 300.0, true),
            piece("n", 0.0, 200.0, 320.0, 120.0, true),
        ];
        let out = settle(&p, &HashMap::new(), &causes(&["c"]));
        assert_eq!(moved(&out, "c"), None, "the cause stays where it was put");
        let (dx, dy) = moved(&out, "n").unwrap();
        assert_eq!(dx, 0.0);
        assert!(dy > 0.0 && dy % GRID == 0.0);
        let r = after(&p, &out);
        assert!(r[1].top() >= r[0].bottom() + GAP);
    }

    #[test]
    fn collision_off_is_never_moved() {
        let p = [
            piece("c", 0.0, 0.0, 320.0, 300.0, true),
            piece("n", 0.0, 200.0, 320.0, 120.0, false),
        ];
        assert!(settle(&p, &HashMap::new(), &causes(&["c"])).is_empty());
    }

    #[test]
    fn a_chain_pushes_until_nothing_overlaps() {
        let p = [
            piece("c", 0.0, 0.0, 320.0, 300.0, true),
            piece("a", 0.0, 200.0, 320.0, 120.0, true),
            piece("b", 0.0, 330.0, 320.0, 120.0, true),
            piece("far", 2000.0, 0.0, 100.0, 100.0, true),
        ];
        let out = settle(&p, &HashMap::new(), &causes(&["c"]));
        assert!(moved(&out, "a").is_some() && moved(&out, "b").is_some());
        assert_eq!(moved(&out, "far"), None, "unrelated items stay");
        let r = after(&p, &out);
        for i in 0..r.len() {
            for j in i + 1..r.len() {
                assert!(!r[i].overlaps(&r[j], 0.0), "{i} and {j} overlap");
            }
        }
    }

    #[test]
    fn boxed_in_by_fixed_items_relocates_to_free_space() {
        // The note sits in a slot walled by fixed items on every side but the
        // cause's; every short move would land on something fixed.
        let mut p = vec![
            piece("cause", 0.0, 0.0, 300.0, 300.0, true),
            piece("n", 0.0, 0.0, 200.0, 200.0, true),
        ];
        for (i, (x, y)) in [(0.0, 400.0), (0.0, -400.0), (400.0, 0.0), (-400.0, 0.0)]
            .iter()
            .enumerate()
        {
            p.push(piece(&format!("w{i}"), *x, *y, 500.0, 500.0, false));
        }
        let out = settle(&p, &HashMap::new(), &causes(&["cause"]));
        let r = after(&p, &out);
        for k in 0..r.len() {
            if k != 1 {
                assert!(!r[1].overlaps(&r[k], 0.0), "the note overlaps {k}");
            }
        }
    }

    #[test]
    fn a_group_is_pushed_as_a_whole() {
        let mut p = vec![
            piece("d", 0.0, 0.0, 400.0, 400.0, true),
            piece("a", 0.0, 250.0, 100.0, 100.0, true),
            piece("b", 150.0, 250.0, 100.0, 100.0, true),
            piece("c", 300.0, 250.0, 100.0, 100.0, true),
        ];
        for q in &mut p[1..] {
            q.group = Some("g".into());
        }
        let groups = HashMap::from([("g".to_string(), true)]);
        let out = settle(&p, &groups, &causes(&["d"]));
        let shifts: Vec<_> = ["a", "b", "c"]
            .iter()
            .map(|id| moved(&out, id).unwrap())
            .collect();
        assert!(
            shifts.windows(2).all(|w| w[0] == w[1]),
            "members move by the same amount: {shifts:?}"
        );
        let r = after(&p, &out);
        let outline = padded(Rect::around(&r[1..]).unwrap());
        assert!(!r[0].overlaps(&outline, 0.0));
    }

    #[test]
    fn outsiders_keep_clear_of_a_groups_outline_and_a_fixed_group_holds_its_members() {
        let mut p = vec![
            piece("a", 0.0, 0.0, 100.0, 100.0, true),
            piece("b", 300.0, 0.0, 100.0, 100.0, true),
        ];
        for q in &mut p {
            q.group = Some("g".into());
        }
        // A note dropped into the gap between members, outside both.
        p.push(piece("n", 150.0, 0.0, 80.0, 80.0, true));
        let out = settle(
            &p,
            &HashMap::from([("g".to_string(), false)]),
            &causes(&["g"]),
        );
        assert_eq!(moved(&out, "a"), None);
        let r = after(&p, &out);
        assert!(!r[2].overlaps(&padded(Rect::around(&r[..2]).unwrap()), 0.0));
    }

    #[test]
    fn the_push_is_bounded_on_a_packed_board() {
        let mut p = vec![piece("cause", 0.0, 0.0, 4000.0, 4000.0, true)];
        for i in 0..400 {
            p.push(piece(
                &format!("n{i}"),
                (i % 20) as f64 * 100.0 - 1000.0,
                (i / 20) as f64 * 100.0 - 1000.0,
                96.0,
                96.0,
                true,
            ));
        }
        let out = settle(&p, &HashMap::new(), &causes(&["cause"]));
        assert!(out.len() <= MAX_PUSHES);
    }

    fn homed(id: &str, x: f64, y: f64, w: f64, h: f64, home: (f64, f64)) -> Piece {
        Piece {
            home: Some(home),
            ..piece(id, x, y, w, h, true)
        }
    }

    #[test]
    fn a_pushed_note_returns_home_once_the_space_frees() {
        // The checklist shrank back to 200 tall; the note was pushed from y=200 to y=360.
        let p = [
            piece("c", 0.0, 0.0, 320.0, 200.0, true),
            homed("n", 0.0, 360.0, 320.0, 120.0, (0.0, 200.0)),
        ];
        let out = settle(&p, &HashMap::new(), &causes(&["c"]));
        assert_eq!(moved(&out, "n"), Some((0.0, -160.0)), "all the way home");
    }

    #[test]
    fn a_pushed_note_stays_while_home_is_taken() {
        let p = [
            piece("c", 0.0, 100.0, 320.0, 400.0, true),
            homed("n", 0.0, 400.0, 320.0, 120.0, (0.0, 200.0)),
        ];
        // A deletion elsewhere triggers settling; the checklist still covers home.
        let out = settle(&p, &HashMap::new(), &causes(&[]));
        assert_eq!(moved(&out, "n"), None);
    }

    #[test]
    fn a_return_stops_short_of_what_is_in_the_way() {
        // Home is at y=0; a fixed item now sits at y=0..100 (centre 50).
        let p = [
            piece("f", 0.0, 50.0, 320.0, 100.0, false),
            homed("n", 0.0, 600.0, 320.0, 120.0, (0.0, 60.0)),
        ];
        let out = settle(&p, &HashMap::new(), &causes(&[]));
        let (_, dy) = moved(&out, "n").expect("it comes part of the way");
        let r = after(&p, &out);
        assert!(
            dy < 0.0 && r[1].top() >= r[0].bottom() + GAP,
            "never past what blocks it, a gap kept"
        );
        assert!(r[1].y > 60.0, "never past home");
    }

    #[test]
    fn something_pushed_in_this_batch_does_not_bounce_back() {
        let p = [
            piece("c", 0.0, 0.0, 320.0, 300.0, true),
            homed("n", 0.0, 200.0, 320.0, 120.0, (0.0, 100.0)),
        ];
        let out = settle(&p, &HashMap::new(), &causes(&["c"]));
        let (_, dy) = moved(&out, "n").unwrap();
        assert!(dy > 0.0, "pushed further, not returned into the cause");
    }

    #[test]
    fn a_group_pushed_whole_returns_whole() {
        let mut a = homed("a", 0.0, 400.0, 100.0, 100.0, (0.0, 200.0));
        let mut b = homed("b", 200.0, 400.0, 100.0, 100.0, (200.0, 200.0));
        a.group = Some("g".into());
        b.group = Some("g".into());
        let groups = HashMap::from([("g".to_string(), true)]);
        let out = settle(&[a, b], &groups, &causes(&[]));
        assert_eq!(moved(&out, "a"), Some((0.0, -200.0)));
        assert_eq!(moved(&out, "b"), Some((0.0, -200.0)));
    }
}
