//! The read tools: a desk, a board, an item, the neighbourhood of one thing,
//! search and history, as Markdown sized for a model's context
//! (agents/board-reading). Nothing here writes.

use serde_json::{Value, json};

use crate::AppState;
use crate::agent::board::{Anchored, Board, BoardData, Fail, db_fail, find_board, short_time};
use crate::agent::diagram::Extracted;
use crate::agent::{Caller, Out, arg_i64, arg_str, opt_str};
use crate::boards::{ItemRow, ref_letter};

/// Hypotheses, settled by the eval (tasks 9.x); see OPEN_QUESTIONS.md.
pub const OVERVIEW_BUDGET_CHARS: usize = 6_000;
pub const READ_WINDOW_LINES: usize = 100;
pub const SEARCH_CAP: i64 = 20;
pub const CHANGES_CAP: usize = 60;

/// A `canvas_operation` row: revision, actor, agent, time, body.
type LogRow = (i64, Option<String>, Option<String>, String, String);
/// A desk row: id, title, revision, diagrams, notes, checklists, images, open tasks, blocked tasks, last change.
type DeskRow = (String, String, i64, i64, i64, i64, i64, i64, i64, String);
/// How many element names an overview line shows before "+N".
const OVERVIEW_ELEMENTS: usize = 4;

/// A constant, unless the eval overrides it (`VISARIUM_AGENT_<NAME>`), so
/// variants are compared on one build (agent-access task 9.2). Not a setting:
/// nothing documents it for operators.
fn knob(name: &str, default: usize) -> usize {
    std::env::var(format!("VISARIUM_AGENT_{name}"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

// --- desk -----------------------------------------------------------------------

pub async fn desk(app: &AppState) -> Result<Out, Fail> {
    let rows: Vec<DeskRow> = sqlx::query_as(
        "SELECT c.id, c.title, c.revision,
                (SELECT count(*) FROM canvas_item i WHERE i.canvas_id = c.id AND i.kind = 'diagram'),
                (SELECT count(*) FROM canvas_item i WHERE i.canvas_id = c.id AND i.kind = 'note'),
                (SELECT count(*) FROM canvas_item i WHERE i.canvas_id = c.id AND i.kind = 'checklist'),
                (SELECT count(*) FROM canvas_item i WHERE i.canvas_id = c.id AND i.kind = 'image'),
                (SELECT count(*) FROM canvas_item i, json_each(i.body, '$.tasks') t
                  WHERE i.canvas_id = c.id AND i.kind = 'checklist' AND json_extract(t.value, '$.state') <> 'done'),
                (SELECT count(*) FROM canvas_item i, json_each(i.body, '$.tasks') t
                  WHERE i.canvas_id = c.id AND i.kind = 'checklist' AND json_extract(t.value, '$.state') = 'blocked'),
                c.updated_at
           FROM canvas c ORDER BY c.updated_at DESC",
    )
    .fetch_all(&app.db)
    .await
    .map_err(db_fail)?;
    if rows.is_empty() {
        return Ok(Out::text("The desk is empty: no boards yet."));
    }
    let mut text = format!(
        "# Desk · {} board{}, most recently changed first\n\n",
        rows.len(),
        if rows.len() == 1 { "" } else { "s" }
    );
    for (id, title, rev, d, n, c, i, open, blocked, at) in &rows {
        let mut counts = vec![];
        for (count, word) in [(d, "diagram"), (n, "note"), (c, "checklist"), (i, "image")] {
            if *count > 0 {
                counts.push(format!(
                    "{count} {word}{}",
                    if *count == 1 { "" } else { "s" }
                ));
            }
        }
        let tasks = if *open > 0 {
            format!(
                " · {open} open tasks{}",
                if *blocked > 0 {
                    format!(", {blocked} blocked")
                } else {
                    String::new()
                }
            )
        } else {
            String::new()
        };
        let last: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT actor_id, actor_agent FROM canvas_operation WHERE canvas_id = ? ORDER BY revision DESC LIMIT 1")
                .bind(id)
                .fetch_optional(&app.db)
                .await
                .map_err(db_fail)?;
        let by = match last {
            Some((who, agent)) => {
                let name: Option<String> =
                    sqlx::query_scalar("SELECT display_name FROM app_user WHERE id = ?")
                        .bind(&who)
                        .fetch_optional(&app.db)
                        .await
                        .map_err(db_fail)?;
                let name = name.unwrap_or_else(|| "someone".into());
                format!(
                    " by {}",
                    agent.map_or(name.clone(), |a| format!("{a} for {name}"))
                )
            }
            // No change yet: say who made it, when an agent did.
            None => {
                let made: Option<(String, Option<String>)> = sqlx::query_as(
                    "SELECT c.created_by_agent, u.display_name FROM canvas c LEFT JOIN app_user u ON u.id = c.owner_id
                      WHERE c.id = ? AND c.created_by_agent IS NOT NULL",
                )
                .bind(id)
                .fetch_optional(&app.db)
                .await
                .map_err(db_fail)?;
                made.map_or(String::new(), |(agent, owner)| {
                    format!(" · made by {agent} for {}", owner.unwrap_or_else(|| "someone".into()))
                })
            }
        };
        text.push_str(&format!(
            "- \"{title}\" · {} · rev {rev}{tasks} · last change {}{by} · id {id}\n",
            if counts.is_empty() {
                "empty".into()
            } else {
                counts.join(", ")
            },
            short_time(at)
        ));
    }
    text.push_str("\nRead one with board_read(board: \"<name>\").");
    Ok(Out::text(text))
}

// --- the overview ------------------------------------------------------------------

/// One line per item, plus its links, as the overview and trace show it.
fn item_line(b: &BoardData, i: &ItemRow) -> String {
    let title = b.title_of(i);
    let title = if title.is_empty() {
        String::new()
    } else {
        format!(" \"{title}\"")
    };
    let detail = match i.kind.as_str() {
        "note" => {
            let words = i.body.as_deref().unwrap_or("").split_whitespace().count();
            format!("{words} words")
        }
        "diagram" => match b.structure(i) {
            Some(Extracted::Known(s)) => {
                let shown: Vec<&str> = s
                    .elements
                    .iter()
                    .take(knob("OVERVIEW_ELEMENTS", OVERVIEW_ELEMENTS))
                    .map(String::as_str)
                    .collect();
                let more = s
                    .elements
                    .len()
                    .saturating_sub(knob("OVERVIEW_ELEMENTS", OVERVIEW_ELEMENTS));
                format!(
                    "{} elements: {}{}{}",
                    s.elements.len(),
                    shown.join(", "),
                    if more > 0 {
                        format!(", +{more}")
                    } else {
                        String::new()
                    },
                    if s.warning.is_some() {
                        " · ⚠ does not parse"
                    } else {
                        ""
                    }
                )
            }
            _ => "elements not extracted for this type".into(),
        },
        "checklist" => match b.checklist(i) {
            Ok(list) => {
                let done = list.tasks.iter().filter(|t| t.state == "done").count();
                let mut s = format!("{done}/{} done", list.tasks.len());
                let blocked: Vec<_> = list.tasks.iter().filter(|t| t.state == "blocked").collect();
                if !blocked.is_empty() {
                    let named: Vec<String> = blocked
                        .iter()
                        .take(3)
                        .map(|t| format!("{} \"{}\"", t.id, clip(&t.text, 40)))
                        .collect();
                    s.push_str(&format!(
                        " · {} blocked ({})",
                        blocked.len(),
                        named.join(", ")
                    ));
                }
                let doing = list.tasks.iter().filter(|t| t.state == "doing").count();
                if doing > 0 {
                    s.push_str(&format!(" · {doing} doing"));
                }
                s
            }
            Err(e) => e,
        },
        "image" => format!(
            "{}×{}",
            i.intrinsic_width.unwrap_or(0),
            i.intrinsic_height.unwrap_or(0)
        ),
        _ => String::new(),
    };
    let mut line = format!("{:<4}{}{} · {}", i.short_ref(), b.kind_of(i), title, detail);
    let links = links_of_item(b, i);
    if !links.is_empty() {
        line.push_str(&format!("\n    {}", links.join(" · ")));
    }
    line
}

/// `→ describes d1#OpQueue`, `← n3 describes d2#Server`, with broken ones marked.
fn links_of_item(b: &BoardData, i: &ItemRow) -> Vec<String> {
    let mut out = vec![];
    for l in &b.links {
        let broken = b.anchored(&l.from_item, l.from_element.as_deref()) == Anchored::Broken
            || b.anchored(&l.to_item, l.to_element.as_deref()) == Anchored::Broken;
        let mark = if broken { " ⚠ broken" } else { "" };
        if l.from_item == i.id {
            let from = l
                .from_element
                .as_ref()
                .map(|e| format!("#{e} "))
                .unwrap_or_default();
            out.push(format!(
                "{from}→ {} {}{mark}",
                l.link_type,
                b.anchor_text(&l.to_item, l.to_element.as_deref())
            ));
        }
        if l.to_item == i.id {
            out.push(format!(
                "← {} {} {}{mark}",
                b.anchor_text(&l.from_item, l.from_element.as_deref()),
                l.link_type,
                b.anchor_text(&l.to_item, l.to_element.as_deref())
            ));
        }
    }
    out
}

/// `note "Why OpQueue is per tab"`: what an item is, in a few words.
fn brief(b: &BoardData, i: &ItemRow) -> String {
    let t = b.title_of(i);
    if t.is_empty() {
        b.kind_of(i)
    } else {
        format!("{} \"{t}\"", b.kind_of(i))
    }
}

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s.to_string()
    }
}

fn kind_order(i: &ItemRow) -> (usize, i64) {
    (
        ["d", "n", "c", "i"]
            .iter()
            .position(|l| *l == ref_letter(&i.kind))
            .unwrap_or(9),
        i.ref_no,
    )
}

pub async fn last_change(app: &AppState, b: &BoardData) -> Result<Option<String>, Fail> {
    let row: Option<LogRow> = sqlx::query_as(
        "SELECT revision, actor_id, actor_agent, at, body FROM canvas_operation WHERE canvas_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .bind(b.id.to_string())
    .fetch_optional(&app.db)
    .await
    .map_err(db_fail)?;
    Ok(row.map(|(_, by, agent, at, body)| {
        let op: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        format!(
            "{} by {}: {}",
            short_time(&at),
            b.credit(by.as_deref(), agent.as_deref()),
            describe(b, &op)
        )
    }))
}

pub async fn board_read(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let broken = b.broken_links();
    let mut text = format!(
        "# {} · rev {} · {} items · {} links{}\n",
        b.title,
        b.revision,
        b.items.len(),
        b.links.len(),
        if broken.is_empty() {
            String::new()
        } else {
            format!(" · {} broken", broken.len())
        }
    );
    if let Some(last) = last_change(app, &b).await? {
        text.push_str(&format!("Last change {last}.\n"));
    }
    text.push_str(&format!(
        "You are {} for {}. item_read(ref) reads one thing in full; trace(ref) follows it. `d2#Server` names an element inside a diagram.\n",
        caller.agent, caller.user.display_name
    ));

    // Sections: each group, then the loose items.
    let mut sections: Vec<(Option<&crate::agent::board::Group>, Vec<&ItemRow>)> = b
        .groups
        .iter()
        .map(|g| {
            (
                Some(g),
                b.items
                    .iter()
                    .filter(|i| i.group_id.as_deref() == Some(g.id.as_str()))
                    .collect(),
            )
        })
        .collect();
    sections.push((
        None,
        b.items.iter().filter(|i| i.group_id.is_none()).collect(),
    ));
    for (_, items) in &mut sections {
        items.sort_by_key(|i| kind_order(i));
    }
    let focus = opt_str(args, "focus")
        .map(|f| b.resolve_group(f))
        .transpose()?;
    if let Some(g) = focus {
        sections.retain(|(sg, _)| sg.is_some_and(|sg| sg.id == g.id));
    }
    let header = |g: Option<&crate::agent::board::Group>| match g {
        Some(g) => {
            let label = g
                .label
                .as_deref()
                .filter(|l| !l.is_empty())
                .map(|l| format!(" \"{l}\""))
                .unwrap_or_default();
            format!(
                "## {}{label} ({})",
                if g.frame { "Frame" } else { "Group" },
                g.short_ref()
            )
        }
        None => "## Loose".to_string(),
    };
    let mut skipped: Vec<String> = vec![];
    for (g, items) in &sections {
        if items.is_empty() && g.is_some() {
            continue;
        }
        if items.is_empty() {
            continue;
        }
        let body: Vec<String> = items.iter().map(|i| item_line(&b, i)).collect();
        let section = format!("\n{}\n{}\n", header(*g), body.join("\n"));
        if focus.is_none() && text.len() + section.len() > OVERVIEW_BUDGET_CHARS {
            skipped.push(match g {
                Some(g) => format!(
                    "{} {} ({}): {} items; board_read(board: \"{}\", focus: \"{}\")",
                    if g.frame { "frame" } else { "group" },
                    g.label
                        .as_deref()
                        .map(|l| format!("\"{l}\""))
                        .unwrap_or_default(),
                    g.short_ref(),
                    items.len(),
                    b.title,
                    g.short_ref()
                ),
                None => format!(
                    "{} loose items, not shown: search(query, board: \"{}\") or item_read a ref",
                    items.len(),
                    b.title
                ),
            });
            continue;
        }
        text.push_str(&section);
    }
    if !skipped.is_empty() {
        text.push_str(&format!(
            "\n## Not shown (over the overview's budget)\n{}\n",
            skipped
                .iter()
                .map(|s| format!("- {s}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !broken.is_empty() && focus.is_none() {
        text.push_str("\n## Broken links\n");
        for l in &broken {
            let (item, element) =
                if b.anchored(&l.to_item, l.to_element.as_deref()) == Anchored::Broken {
                    (&l.to_item, l.to_element.as_deref().unwrap_or(""))
                } else {
                    (&l.from_item, l.from_element.as_deref().unwrap_or(""))
                };
            text.push_str(&format!(
                "- {} {} {}: {} no longer declares {element}\n",
                b.anchor_text(&l.from_item, l.from_element.as_deref()),
                l.link_type,
                b.anchor_text(&l.to_item, l.to_element.as_deref()),
                b.ref_of(item)
            ));
        }
    }
    if focus.is_none() && !b.items.is_empty() {
        text.push_str(&layout_section(&b));
    }
    if b.items.is_empty() {
        text.push_str("\nThe board is empty. item_create adds a note, diagram, checklist or image.\n");
    }
    Ok(Out::text(text)
        .touch(b.id, None, "reading")
        .with(json!({ "board": b.id, "revision": b.revision })))
}

/// How many layout problems the overview names before counting the rest.
const LAYOUT_LINES: usize = 8;

/// The board's layout in words (agents/board-reading): overlapping items,
/// links that run through items or frames, and links far longer than the
/// board's typical one, worst first. Pairs where nothing can move are a
/// person's own arrangement and are left out.
///
/// ponytail: overlaps are checked pairwise, O(n²); use the spatial index if
/// boards past a few thousand items read slowly.
fn layout_section(b: &BoardData) -> String {
    use crate::agent::place::{self, Rect};
    let pad = crate::collision::GROUP_PAD;
    let mut problems: Vec<(f64, String)> = vec![];
    for (n, a) in b.items.iter().enumerate() {
        for c in &b.items[n + 1..] {
            if !(b.collides(a) || b.collides(c)) {
                continue;
            }
            let (ra, rc) = (Rect::of(a), Rect::of(c));
            if ra.overlaps(&rc, 0.0) {
                let w = ra.right().min(rc.right()) - ra.left().max(rc.left());
                let h = ra.bottom().min(rc.bottom()) - ra.top().max(rc.top());
                problems.push((1e9 + w * h, format!("{} overlaps {}", a.short_ref(), c.short_ref())));
            }
        }
    }
    let mut lengths = vec![];
    let mut drawn = vec![];
    for l in &b.links {
        let (Some(from), Some(to)) = (b.item(&l.from_item), b.item(&l.to_item)) else { continue };
        let s = place::segment(&place::anchor_box(from, l.from_element.as_deref()), &place::anchor_box(to, l.to_element.as_deref()));
        lengths.push(place::length(&s));
        drawn.push((l, from, to, s));
    }
    lengths.sort_by(f64::total_cmp);
    let typical = lengths.get(lengths.len() / 2).copied().unwrap_or(0.0);
    for (l, from, to, s) in drawn {
        if !(b.collides(from) || b.collides(to)) {
            continue;
        }
        let label = format!(
            "{} → {}",
            b.anchor_text(&l.from_item, l.from_element.as_deref()),
            b.anchor_text(&l.to_item, l.to_element.as_deref())
        );
        let mut crossed: Vec<String> = b
            .items
            .iter()
            .filter(|i| i.id != from.id && i.id != to.id && place::hits(&s, &Rect::of(i)))
            .map(|i| i.short_ref())
            .collect();
        for g in &b.groups {
            let members: Vec<&crate::boards::ItemRow> = b.items.iter().filter(|i| i.group_id.as_deref() == Some(g.id.as_str())).collect();
            if members.iter().any(|m| m.id == from.id || m.id == to.id) {
                continue;
            }
            if let Some(r) = Rect::around(&members.iter().map(|m| Rect::of(m)).collect::<Vec<_>>())
                && place::hits(&s, &Rect { w: r.w + 2.0 * pad, h: r.h + 2.0 * pad, ..r })
            {
                crossed.push(g.short_ref());
            }
        }
        if !crossed.is_empty() {
            problems.push((1e6 * crossed.len() as f64, format!("{label} crosses {}", crossed.join(", "))));
        }
        let len = place::length(&s);
        if lengths.len() >= 3 && typical > 0.0 && len > 3.0 * typical {
            problems.push((len, format!("{label} is {}px long (typical {}px)", len.round(), typical.round())));
        }
    }
    if problems.is_empty() {
        return "\nLayout: no overlaps or crossings.\n".into();
    }
    problems.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut out = String::from("\n## Layout\n");
    for (_, p) in problems.iter().take(LAYOUT_LINES) {
        out.push_str(&format!("- {p}\n"));
    }
    if problems.len() > LAYOUT_LINES {
        out.push_str(&format!("- and {} more\n", problems.len() - LAYOUT_LINES));
    }
    out
}

// --- one item --------------------------------------------------------------------

pub async fn item_read(app: &AppState, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let i = b.resolve_item(arg_str(args, "ref")?)?;
    let title = b.title_of(i);
    let mut text = format!(
        "## {} · {}{} · rev {}\n",
        i.short_ref(),
        b.kind_of(i),
        if title.is_empty() {
            String::new()
        } else {
            format!(" · \"{title}\"")
        },
        i.revision
    );
    if let Some(changed) = item_changed(app, &b, &i.id).await? {
        text.push_str(&format!("Last changed {changed}.\n"));
    }
    if let Some(g) = i.group_id.as_deref().and_then(|g| b.group(g)) {
        text.push_str(&format!(
            "In {} \"{}\".\n",
            g.short_ref(),
            g.label.as_deref().unwrap_or("")
        ));
    }
    let links = links_of_item(&b, i);
    if !links.is_empty() {
        text.push_str(&format!("Links: {}\n", links.join(" · ")));
    }
    match i.kind.as_str() {
        "checklist" => {
            let list = b.checklist(i)?;
            let done = list.tasks.iter().filter(|t| t.state == "done").count();
            text.push_str(&format!(
                "{done}/{} done. Change tasks with tasks(ref: \"{}\", …).\n\n",
                list.tasks.len(),
                i.short_ref()
            ));
            for t in &list.tasks {
                let who =
                    t.by.as_ref()
                        .map(|by| {
                            format!(
                                " — {}, {}",
                                b.credit(Some(by), t.by_agent.as_deref()),
                                short_time(t.at.as_deref().unwrap_or(""))
                            )
                        })
                        .unwrap_or_default();
                text.push_str(&format!(
                    "- {}/{} [{}] {}{who}\n",
                    i.short_ref(),
                    t.id,
                    t.state,
                    t.text
                ));
            }
        }
        "image" => {
            text.push_str(&format!(
                "{}×{} pixels{}. Look at it with item_view(ref: \"{}\").\n",
                i.intrinsic_width.unwrap_or(0),
                i.intrinsic_height.unwrap_or(0),
                if i.crop_x.is_some() {
                    ", shown cropped"
                } else {
                    ""
                },
                i.short_ref()
            ));
        }
        _ => {
            if i.kind == "diagram" {
                match b.structure(i) {
                    Some(Extracted::Known(s)) => {
                        text.push_str(&format!(
                            "Elements ({}): {}\n",
                            s.elements.len(),
                            s.elements.join(", ")
                        ));
                        if !s.edges.is_empty() {
                            text.push_str(&format!("Edges ({}):\n", s.edges.len()));
                            for e in &s.edges {
                                let label = e
                                    .label
                                    .as_ref()
                                    .map(|l| format!(": {l}"))
                                    .unwrap_or_default();
                                text.push_str(&format!("- {} → {}{label}\n", e.from, e.to));
                            }
                        }
                        if let Some((line, why)) = &s.warning {
                            text.push_str(&format!("⚠ Line {line} does not parse: {why}\n"));
                        }
                        let on: Vec<String> = s
                            .elements
                            .iter()
                            .filter_map(|e| {
                                let ls: Vec<String> = b
                                    .links
                                    .iter()
                                    .filter(|l| {
                                        l.to_item == i.id
                                            && l.to_element.as_deref() == Some(e.as_str())
                                    })
                                    .map(|l| {
                                        format!(
                                            "← {} {}",
                                            b.anchor_text(&l.from_item, l.from_element.as_deref()),
                                            l.link_type
                                        )
                                    })
                                    .collect();
                                (!ls.is_empty()).then(|| format!("- {e}: {}", ls.join(", ")))
                            })
                            .collect();
                        if !on.is_empty() {
                            text.push_str(&format!("Links on elements:\n{}\n", on.join("\n")));
                        }
                    }
                    Some(Extracted::Unsupported(t)) => {
                        text.push_str(&format!("Elements: not extracted for {t}.\n"))
                    }
                    None => {}
                }
            }
            let source = i.body.as_deref().unwrap_or("");
            let lines: Vec<&str> = source.lines().collect();
            let offset = arg_i64(args, "offset").unwrap_or(0).max(0) as usize;
            let end = (offset + knob("READ_WINDOW_LINES", READ_WINDOW_LINES)).min(lines.len());
            let fence = match (i.kind.as_str(), i.lang.as_deref()) {
                ("diagram", Some(l)) => l,
                _ => "markdown",
            };
            text.push_str(&format!(
                "\nSource, lines {}–{} of {} (to change it: item_edit with base_rev {}):\n```{fence}\n",
                (offset + 1).min(lines.len().max(1)),
                end,
                lines.len(),
                i.revision
            ));
            for (n, l) in lines.iter().enumerate().take(end).skip(offset) {
                text.push_str(&format!("{:>4}  {l}\n", n + 1));
            }
            text.push_str("```\n");
            if end < lines.len() {
                text.push_str(&format!(
                    "More: item_read(ref: \"{}\", offset: {end}).\n",
                    i.short_ref()
                ));
            }
        }
    }
    let item_id = i.id.clone();
    Ok(Out::text(text)
        .touch(b.id, Some(item_id), "reading")
        .with(json!({ "ref": i.short_ref(), "revision": i.revision })))
}

async fn item_changed(app: &AppState, b: &BoardData, item: &str) -> Result<Option<String>, Fail> {
    let row: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT actor_id, actor_agent, at FROM canvas_operation
          WHERE canvas_id = ? AND (json_extract(body, '$.itemId') = ?1 OR json_extract(body, '$.from.itemId') = ?2)
          ORDER BY revision DESC LIMIT 1",
    )
    .bind(b.id.to_string())
    .bind(item)
    .bind(item)
    .fetch_optional(&app.db)
    .await
    .map_err(db_fail)?;
    Ok(row.map(|(by, agent, at)| {
        format!(
            "{} by {}",
            short_time(&at),
            b.credit(by.as_deref(), agent.as_deref())
        )
    }))
}

// --- trace ----------------------------------------------------------------------

/// `name` as a whole word in `text`.
fn mentions(text: &str, name: &str) -> bool {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + name.len()..].chars().next();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

pub async fn trace(app: &AppState, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let r = arg_str(args, "ref")?;
    let (item, element) = b.resolve_anchor(r, false)?;
    let mut text = String::new();
    match &element {
        Some(name) => {
            let declared = matches!(
                b.anchored(&item.id, Some(name)),
                Anchored::Whole | Anchored::Unknown
            );
            text.push_str(&format!(
                "## {}#{name} — element of {} {}{}\n",
                item.short_ref(),
                item.short_ref(),
                brief(&b, item),
                if declared {
                    ""
                } else {
                    " ⚠ not declared by its source (links to it are broken)"
                }
            ));
            if let Some(Extracted::Known(s)) = b.structure(item) {
                let edges: Vec<String> = s
                    .edges
                    .iter()
                    .filter(|e| &e.from == name || &e.to == name)
                    .map(|e| {
                        format!(
                            "- {} → {}{}",
                            e.from,
                            e.to,
                            e.label
                                .as_ref()
                                .map(|l| format!(": {l}"))
                                .unwrap_or_default()
                        )
                    })
                    .collect();
                text.push_str(&format!(
                    "\nEdges in {}:\n{}\n",
                    item.short_ref(),
                    if edges.is_empty() {
                        "- none".into()
                    } else {
                        edges.join("\n")
                    }
                ));
            }
            let mut linked_ids: Vec<&str> = vec![];
            let linked: Vec<String> = b
                .links
                .iter()
                .filter_map(|l| {
                    if l.to_item == item.id && l.to_element.as_deref() == Some(name.as_str()) {
                        let other = b.item(&l.from_item)?;
                        linked_ids.push(&other.id);
                        Some(format!(
                            "- {} {} it — {}",
                            b.anchor_text(&l.from_item, l.from_element.as_deref()),
                            l.link_type,
                            brief(&b, other)
                        ))
                    } else if l.from_item == item.id
                        && l.from_element.as_deref() == Some(name.as_str())
                    {
                        let other = b.item(&l.to_item)?;
                        linked_ids.push(&other.id);
                        Some(format!(
                            "- it {} {} — {}",
                            l.link_type,
                            b.anchor_text(&l.to_item, l.to_element.as_deref()),
                            brief(&b, other)
                        ))
                    } else {
                        None
                    }
                })
                .collect();
            text.push_str(&format!(
                "\nLinked:\n{}\n",
                if linked.is_empty() {
                    "- nothing links here".into()
                } else {
                    linked.join("\n")
                }
            ));
            let mut matches = vec![];
            for other in &b.items {
                // Already listed as linked: a name match would only repeat it.
                if other.id == item.id || linked_ids.contains(&other.id.as_str()) {
                    continue;
                }
                match other.kind.as_str() {
                    "diagram" => {
                        if let Some(Extracted::Known(s)) = b.structure(other)
                            && s.elements.iter().any(|e| e == name)
                        {
                            matches.push(format!(
                                "- {} {} \"{}\" also declares {name}",
                                other.short_ref(),
                                b.kind_of(other),
                                b.title_of(other)
                            ));
                        }
                    }
                    "note" if mentions(other.body.as_deref().unwrap_or(""), name) => {
                        matches.push(format!(
                            "- {} note \"{}\" mentions {name}",
                            other.short_ref(),
                            b.title_of(other)
                        ));
                    }
                    "checklist" => {
                        if let Ok(list) = b.checklist(other) {
                            for t in list.tasks.iter().filter(|t| mentions(&t.text, name)) {
                                matches.push(format!(
                                    "- {}/{} [{}] \"{}\" mentions {name}",
                                    other.short_ref(),
                                    t.id,
                                    t.state,
                                    t.text
                                ));
                            }
                        }
                    }
                    _ => {}
                }
            }
            if !matches.is_empty() {
                text.push_str(&format!(
                    "\nName matches elsewhere (the same name, not a link):\n{}\n",
                    matches.join("\n")
                ));
            }
        }
        None => {
            text.push_str(&format!(
                "## {}\n{}\n",
                item.short_ref(),
                item_line(&b, item)
            ));
            let mut neighbours = vec![];
            for l in &b.links {
                let (dir, other, this_el, other_el) = if l.from_item == item.id {
                    ("→", &l.to_item, &l.from_element, &l.to_element)
                } else if l.to_item == item.id {
                    ("←", &l.from_item, &l.to_element, &l.from_element)
                } else {
                    continue;
                };
                let Some(o) = b.item(other) else { continue };
                let here = this_el
                    .as_ref()
                    .map(|e| format!("#{e} "))
                    .unwrap_or_default();
                let there = other_el
                    .as_ref()
                    .map(|e| format!(" (at #{e})"))
                    .unwrap_or_default();
                neighbours.push(format!(
                    "- {here}{dir} {} {}{there} — {}",
                    l.link_type,
                    o.short_ref(),
                    brief(&b, o)
                ));
            }
            text.push_str(&format!(
                "\nLinks ({}):\n{}\n",
                neighbours.len(),
                if neighbours.is_empty() {
                    "- none".into()
                } else {
                    neighbours.join("\n")
                }
            ));
            if item.kind == "diagram" {
                text.push_str(&format!(
                    "\nFollow one element with trace(ref: \"{}#<element>\").\n",
                    item.short_ref()
                ));
            }
        }
    }
    let item_id = item.id.clone();
    Ok(Out::text(text).touch(b.id, Some(item_id), "reading"))
}

// --- search -----------------------------------------------------------------------

pub async fn search(app: &AppState, args: &Value) -> Result<Out, Fail> {
    let query = arg_str(args, "query")?;
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-'))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w.replace('"', "")))
        .collect();
    if words.is_empty() {
        return Err("search needs at least one word to look for.".into());
    }
    let fts = words.join(" ");
    let board: Option<Board> = match opt_str(args, "board") {
        Some(n) => Some(find_board(&app.db, n).await?),
        None => None,
    };
    let kind = opt_str(args, "kind").map(str::to_string);
    if let Some(k) = &kind
        && !["note", "diagram", "checklist"].contains(&k.as_str())
    {
        return Err(format!(
            "kind '{k}' is not searchable; use note, diagram or checklist."
        ));
    }
    let filter =
        "item_text MATCH ?1 AND (?2 IS NULL OR t.canvas_id = ?2) AND (?3 IS NULL OR i.kind = ?3)";
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM item_text t JOIN canvas_item i ON i.id = t.item_id WHERE {filter}"
    )))
    .bind(&fts)
    .bind(board.as_ref().map(|b| b.id.to_string()))
    .bind(&kind)
    .fetch_one(&app.db)
    .await
    .map_err(|e| format!("search could not read that query ({e}); use plain words."))?;
    let hits: Vec<(String, String, String, i64, Option<String>, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.title, c.id, i.kind, i.ref_no, i.lang, snippet(item_text, 0, '«', '»', '…', 12)
           FROM item_text t JOIN canvas_item i ON i.id = t.item_id JOIN canvas c ON c.id = i.canvas_id
          WHERE {filter} ORDER BY rank LIMIT ?4"
    )))
    .bind(&fts)
    .bind(board.as_ref().map(|b| b.id.to_string()))
    .bind(&kind)
    .bind(SEARCH_CAP)
    .fetch_all(&app.db)
    .await
    .map_err(db_fail)?;
    if hits.is_empty() {
        return Ok(Out::text(format!(
            "Nothing matches {query:?}{}.",
            board
                .map(|b| format!(" on \"{}\"", b.title))
                .unwrap_or_default()
        )));
    }
    let mut text = format!(
        "{total} match{} for {query:?}:\n",
        if total == 1 { "" } else { "es" }
    );
    for (title, _, kind, ref_no, lang, snippet) in &hits {
        let what = match lang {
            Some(l) => format!("{l} diagram"),
            None => kind.clone(),
        };
        text.push_str(&format!(
            "- \"{title}\" {}{ref_no} ({what}): {}\n",
            ref_letter(kind),
            snippet.replace('\n', " ⏎ ")
        ));
    }
    if total > SEARCH_CAP {
        text.push_str(&format!(
            "{} more not shown. Narrow it: add words, or pass board and/or kind (note, diagram, checklist).\n",
            total - SEARCH_CAP
        ));
    }
    text.push_str("Read one with item_read(board, ref).");
    Ok(Out::text(text))
}

// --- history ---------------------------------------------------------------------

/// What one operation did, without who did it.
pub fn describe(b: &BoardData, op: &Value) -> String {
    let s = |k: &str| op.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let item = || {
        let id = s("itemId");
        b.item(&id)
            .map_or_else(|| "an item since deleted".to_string(), |i| i.short_ref())
    };
    let anchor = |a: &Value| {
        let id = a.get("itemId").and_then(Value::as_str).unwrap_or("");
        b.anchor_text(id, a.get("element").and_then(Value::as_str))
    };
    match op.get("type").and_then(Value::as_str).unwrap_or("") {
        "item.create" => {
            let kind = op
                .pointer("/content/kind")
                .and_then(Value::as_str)
                .unwrap_or("image");
            match b.item(&s("itemId")) {
                Some(i) => {
                    let t = b.title_of(i);
                    format!(
                        "added {} ({kind}{})",
                        i.short_ref(),
                        if t.is_empty() {
                            String::new()
                        } else {
                            format!(" \"{t}\"")
                        }
                    )
                }
                None => format!("added a {kind}, since deleted"),
            }
        }
        "item.delete" => "deleted an item".into(),
        "item.transform" => format!("moved or resized {}", item()),
        "item.z" => format!("restacked {}", item()),
        "item.appearance" => format!("restyled {}", item()),
        "item.content" => format!("finished uploading {}", item()),
        "item.source" => format!("edited the source of {}", item()),
        "checklist.title" => format!("retitled {} to \"{}\"", item(), s("title")),
        "task.add" => format!(
            "added task {}/{} \"{}\"",
            item(),
            op.pointer("/task/id").and_then(Value::as_str).unwrap_or(""),
            op.pointer("/task/text")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        "task.set" => {
            let mut what = vec![];
            if let Some(state) = op.get("state").and_then(Value::as_str) {
                what.push(format!("to {state}"));
            }
            if let Some(text) = op.get("text").and_then(Value::as_str) {
                what.push(format!("text \"{text}\""));
            }
            format!("set {}/{} {}", item(), s("taskId"), what.join(", "))
        }
        "task.remove" => format!("removed task {}/{}", item(), s("taskId")),
        "link.add" => format!(
            "linked {} {} {}",
            anchor(op.get("from").unwrap_or(&Value::Null)),
            s("linkType"),
            anchor(op.get("to").unwrap_or(&Value::Null))
        ),
        "link.set" => format!("changed a link's type to {}", s("linkType")),
        "link.delete" => "removed a link".into(),
        "group.create" => "made a group".into(),
        "group.delete" => "removed a group".into(),
        "group.members" => "changed a group's members".into(),
        "group.label" => format!("renamed a group to \"{}\"", s("label")),
        "group.frame" => "framed or unframed a group".into(),
        "item.collides" => format!(
            "turned collision {} for {}",
            if op.get("collides").and_then(Value::as_bool) == Some(true) { "on" } else { "off" },
            item()
        ),
        "group.collides" => format!(
            "turned collision {} for a group",
            if op.get("collides").and_then(Value::as_bool) == Some(true) { "on" } else { "off" }
        ),
        other => format!("did {other}"),
    }
}

pub async fn changes(app: &AppState, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let since = arg_i64(args, "since_rev")
        .ok_or("changes needs since_rev: the revision you last read (board_read shows it).")?;
    if since >= b.revision {
        return Ok(Out::text(format!(
            "Nothing has changed on \"{}\" since rev {since}; it is at rev {}.",
            b.title, b.revision
        )));
    }
    let oldest: Option<i64> =
        sqlx::query_scalar("SELECT min(revision) FROM canvas_operation WHERE canvas_id = ?")
            .bind(b.id.to_string())
            .fetch_one(&app.db)
            .await
            .map_err(db_fail)?;
    let rows: Vec<LogRow> = sqlx::query_as(
        "SELECT revision, actor_id, actor_agent, at, body FROM canvas_operation WHERE canvas_id = ? AND revision > ? ORDER BY revision",
    )
    .bind(b.id.to_string())
    .bind(since)
    .fetch_all(&app.db)
    .await
    .map_err(db_fail)?;
    let mut text = format!(
        "# Changes on \"{}\" after rev {since} (now rev {})\n",
        b.title, b.revision
    );
    if oldest.is_none_or(|o| o > since + 1) {
        text.push_str(&format!(
            "History before rev {} is not kept, so this may be incomplete; board_read shows the board as it is.\n",
            oldest.unwrap_or(b.revision + 1)
        ));
    }
    // Runs of the same person doing the same layout change fold into one line.
    let foldable = ["item.transform", "item.z", "item.appearance"];
    let mut lines: Vec<String> = vec![];
    let mut i = 0;
    while i < rows.len() {
        let (rev, by, agent, at, body) = &rows[i];
        let op: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let ty = op
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut j = i + 1;
        if foldable.contains(&ty.as_str()) {
            while j < rows.len()
                && rows[j].1 == *by
                && rows[j].2 == *agent
                && rows[j].4.contains(&format!("\"type\":\"{ty}\""))
            {
                j += 1;
            }
        }
        let who = b.credit(by.as_deref(), agent.as_deref());
        let what = if j - i > 1 {
            let verb = match ty.as_str() {
                "item.transform" => "moved or resized",
                "item.z" => "restacked",
                _ => "restyled",
            };
            // Name them while that stays short: pushes read as what moved.
            let refs: Vec<String> = rows[i..j]
                .iter()
                .filter_map(|r| serde_json::from_str::<Value>(&r.4).ok())
                .filter_map(|o| o.get("itemId").and_then(Value::as_str).map(str::to_string))
                .filter_map(|id| b.items.iter().find(|it| it.id == id).map(|it| it.short_ref()))
                .collect();
            if refs.len() == j - i && refs.len() <= 6 {
                format!("{verb} {}", refs.join(", "))
            } else {
                format!("{verb} {} items", j - i)
            }
        } else {
            describe(&b, &op)
        };
        let range = if j - i > 1 {
            format!("rev {}–{}", rev, rows[j - 1].0)
        } else {
            format!("rev {rev}")
        };
        lines.push(format!("- {range} · {} · {who} {what}", short_time(at)));
        i = j;
    }
    let shown = lines.len().min(CHANGES_CAP);
    text.push_str(&lines[..shown].join("\n"));
    text.push('\n');
    if lines.len() > shown {
        text.push_str(&format!(
            "… and {} more. Ask again with since_rev: {} for the rest.\n",
            lines.len() - shown,
            rows.iter().map(|r| r.0).nth(shown).unwrap_or(b.revision) - 1
        ));
    }
    Ok(Out::text(text).with(json!({ "revision": b.revision })))
}

// --- pixels ------------------------------------------------------------------------

pub async fn item_view(app: &AppState, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let i = b.resolve_item(arg_str(args, "ref")?)?;
    if i.kind != "image" {
        return Err(format!(
            "{} is a {}: notes, diagrams and checklists are read as source with item_read(ref: \"{}\"), not viewed.",
            i.short_ref(),
            i.kind,
            i.short_ref()
        ));
    }
    let width = arg_i64(args, "width").unwrap_or(1024).clamp(1, 4096) as u32;
    let asset = i
        .asset_id
        .as_deref()
        .ok_or("This image has not finished uploading.")?;
    let crop = match (i.crop_x, i.crop_y, i.crop_w, i.crop_h) {
        (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
        _ => None,
    };
    let (bytes, mime, w) = crate::assets::view(app, asset, width, crop)
        .await
        .map_err(|e| format!("The image could not be read: {}", e.detail))?;
    use base64::Engine;
    let mut out = Out::text(format!(
        "{} \"{}\", {w} pixels wide{}.",
        i.short_ref(),
        b.title_of(i),
        if crop.is_some() {
            ", cropped as the board shows it"
        } else {
            ""
        }
    ));
    out.image = Some((
        mime.to_string(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ));
    let item_id = i.id.clone();
    Ok(out.touch(b.id, Some(item_id), "reading"))
}

#[cfg(test)]
mod tests {
    use super::mentions;

    #[test]
    fn mentions_are_whole_words() {
        assert!(mentions("the OpQueue drains", "OpQueue"));
        assert!(!mentions("the OpQueues drain", "OpQueue"));
        assert!(mentions("OpQueue", "OpQueue"));
    }
}
