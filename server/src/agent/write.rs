//! The write tools (agents/board-editing). Each builds ordinary operations,
//! applies them through `boards::apply` like any client's, announces them,
//! and answers with what actually changed, read back from the board.

use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::NOW;
use crate::agent::board::{Anchored, BoardData, Fail, db_fail, find_board, short_time};
use crate::agent::diagram::Extracted;
use crate::agent::place::{self, Rect, Side};
use crate::agent::read::describe;
use crate::agent::{Caller, Out, arg_i64, arg_str, opt_str};
use crate::boards::{self, Anchor, Content, ItemRow, Op, Task, Transform};

const LINK_TYPES: [&str; 4] = ["describes", "comments", "implements", "depends-on"];
const TASK_STATES: [&str; 4] = ["todo", "doing", "done", "blocked"];

pub async fn run(app: &AppState, caller: &Caller, tool: &str, args: &Value) -> Result<Out, Fail> {
    if let Err(wait) = app.agent_writes.take(&caller.key()) {
        return Err(format!(
            "Too many changes from this agent in one minute (the limit is {}). Wait {wait} seconds, then continue.",
            crate::agent::AGENT_WRITES_PER_MINUTE
        ));
    }
    if let Some(earlier) = remembered(app, caller, args).await? {
        return Ok(earlier);
    }
    let out = match tool {
        "item_create" => item_create(app, caller, args).await?,
        "item_edit" => item_edit(app, caller, args).await?,
        "tasks" => tasks(app, caller, args).await?,
        "link" => link(app, caller, args).await?,
        "unlink" => unlink(app, caller, args).await?,
        "arrange" => arrange(app, caller, args).await?,
        _ => item_delete(app, caller, args).await?,
    };
    remember(app, caller, args, &out).await?;
    Ok(out)
}

fn request_id(args: &Value) -> Option<String> {
    opt_str(args, "request_id").map(|r| r.chars().take(200).collect::<String>())
}

/// The first answer to this `request_id`, when the agent is retrying.
pub async fn remembered(app: &AppState, caller: &Caller, args: &Value) -> Result<Option<Out>, Fail> {
    let Some(rid) = request_id(args) else { return Ok(None) };
    let earlier: Option<String> = sqlx::query_scalar(
        "SELECT result FROM agent_request WHERE session_id = ? AND request_id = ?",
    )
    .bind(caller.key())
    .bind(&rid)
    .fetch_optional(&app.db)
    .await
    .map_err(db_fail)?;
    Ok(earlier.map(|earlier| {
        let v: Value = serde_json::from_str(&earlier).unwrap_or(Value::Null);
        let mut out = Out::text(format!(
            "(Already done for request_id \"{rid}\"; nothing was applied again.)\n{}",
            v["text"].as_str().unwrap_or("")
        ));
        out.structured = v.get("structured").cloned().filter(|s| !s.is_null());
        out
    }))
}

/// Keeps this answer for a day under the call's `request_id`, if it has one.
pub async fn remember(app: &AppState, caller: &Caller, args: &Value, out: &Out) -> Result<(), Fail> {
    let Some(rid) = request_id(args) else { return Ok(()) };
    sqlx::query("INSERT OR REPLACE INTO agent_request (session_id, request_id, result) VALUES (?, ?, ?)")
        .bind(caller.key())
        .bind(&rid)
        .bind(json!({ "text": out.text, "structured": out.structured }).to_string())
        .execute(&app.db)
        .await
        .map_err(db_fail)?;
    sqlx::query(
        "DELETE FROM agent_request WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
    )
    .execute(&app.db)
    .await
    .map_err(db_fail)?;
    Ok(())
}

/// Stamps, applies and announces a batch as the agent: the same path as a
/// person's batch through `POST /boards/{id}/operations`.
async fn commit(
    app: &AppState,
    caller: &Caller,
    board: Uuid,
    mut ops: Vec<Op>,
) -> Result<i64, Fail> {
    let at: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {NOW}")))
        .fetch_one(&app.db)
        .await
        .map_err(db_fail)?;
    let actor = caller.actor();
    for op in &mut ops {
        op.stamp(&actor, &at);
    }
    let (from, to) = boards::apply(app, &board, &ops, &actor)
        .await
        .map_err(|e| e.detail)?;
    app.rooms.announce(&board, None, from, to, &ops);
    Ok(to)
}

// --- placement ------------------------------------------------------------------

struct Where {
    side: Side,
    target: Rect,
    group: Option<String>,
    said: String,
}

/// `near`/`below`/`right_of`/`in` from the arguments, or beside what changed
/// last when none is given.
async fn whereabouts(app: &AppState, b: &BoardData, args: &Value) -> Result<Where, Fail> {
    for (key, side, word) in [
        ("in", Side::In, "in"),
        ("below", Side::Below, "below"),
        ("right_of", Side::RightOf, "right of"),
        ("near", Side::Near, "beside"),
    ] {
        let Some(r) = opt_str(args, key) else {
            continue;
        };
        if r.trim_start().starts_with(['g', 'G']) && !r.contains('#') && b.resolve_item(r).is_err()
        {
            let g = b.resolve_group(r)?;
            let members: Vec<Rect> = b
                .items
                .iter()
                .filter(|i| i.group_id.as_deref() == Some(g.id.as_str()))
                .map(Rect::of)
                .collect();
            let target = Rect::around(&members).unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            });
            let group = (side == Side::In).then(|| g.id.clone());
            return Ok(Where {
                side,
                target,
                group,
                said: format!("{word} {}", g.short_ref()),
            });
        }
        if side == Side::In {
            return Err(format!(
                "'in' takes a group or frame ref like g2, not '{r}'. Use near, below or right_of for an item."
            ));
        }
        let (item, _) = b.resolve_anchor(r, false)?;
        return Ok(Where {
            side,
            target: Rect::of(item),
            group: None,
            said: format!("{word} {}", item.short_ref()),
        });
    }
    // Nowhere named: beside the most recently changed item that still exists.
    let recent: Vec<String> = sqlx::query_scalar(
        "SELECT json_extract(body, '$.itemId') FROM canvas_operation WHERE canvas_id = ? AND json_extract(body, '$.itemId') IS NOT NULL
          ORDER BY revision DESC LIMIT 50",
    )
    .bind(b.id.to_string())
    .fetch_all(&app.db)
    .await
    .map_err(db_fail)?;
    let near = recent.iter().find_map(|id| b.item(id)).or(b.items.last());
    Ok(match near {
        Some(i) => Where {
            side: Side::Near,
            target: Rect::of(i),
            group: None,
            said: format!("beside {} (changed last)", i.short_ref()),
        },
        None => Where {
            side: Side::Near,
            target: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            group: None,
            said: "at the centre of the empty board".into(),
        },
    })
}

fn obstacles(b: &BoardData, except: &[&str]) -> Vec<Rect> {
    b.items
        .iter()
        .filter(|i| !except.contains(&i.id.as_str()))
        .map(Rect::of)
        .collect()
}

fn transform(r: Rect) -> Transform {
    Transform {
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        rotation: 0.0,
    }
}

fn group_members(b: &BoardData, group: &str, add: &[String], remove: &[&str]) -> Vec<Uuid> {
    let mut ids: Vec<String> = b
        .items
        .iter()
        .filter(|i| i.group_id.as_deref() == Some(group) && !remove.contains(&i.id.as_str()))
        .map(|i| i.id.clone())
        .collect();
    ids.extend(add.iter().cloned());
    ids.iter().filter_map(|i| Uuid::parse_str(i).ok()).collect()
}

fn anchor(item: &ItemRow, element: Option<String>) -> Anchor {
    Anchor {
        item_id: Uuid::parse_str(&item.id).unwrap(),
        element,
    }
}

fn link_type(args: &Value, key: &str) -> Result<String, Fail> {
    let t = arg_str(args, key)?.trim().to_lowercase();
    if LINK_TYPES.contains(&t.as_str()) {
        Ok(t)
    } else {
        Err(format!(
            "Link type '{t}' is not one of {}.",
            LINK_TYPES.join(", ")
        ))
    }
}

// --- the effect of a change, read back -----------------------------------------------

/// Elements added and removed, and links that broke or were repaired, when a
/// diagram's source changed between two readings of the board.
fn diagram_effect(before: &BoardData, after: &BoardData, item_id: &str) -> Vec<String> {
    let mut lines = vec![];
    // One element out and one in reads as a rename: the hint can name both.
    let mut renamed: Option<(String, String)> = None;
    let (Some(old), Some(new)) = (before.item(item_id), after.item(item_id)) else {
        return lines;
    };
    if new.kind != "diagram" {
        return lines;
    }
    match (before.structure(old), after.structure(new)) {
        (Some(Extracted::Known(a)), Some(Extracted::Known(n))) => {
            let added: Vec<&String> = n
                .elements
                .iter()
                .filter(|e| !a.elements.contains(e))
                .collect();
            let removed: Vec<&String> = a
                .elements
                .iter()
                .filter(|e| !n.elements.contains(e))
                .collect();
            if let ([gone], [came]) = (removed.as_slice(), added.as_slice()) {
                renamed = Some(((*gone).clone(), (*came).clone()));
            }
            if !added.is_empty() || !removed.is_empty() {
                let mut d: Vec<String> = removed.iter().map(|e| format!("−{e}")).collect();
                d.extend(added.iter().map(|e| format!("+{e}")));
                lines.push(format!("Elements: {}", d.join(", ")));
            }
            if let Some((line, why)) = &n.warning {
                lines.push(format!("⚠ Saved, but line {line} does not parse: {why}. The board keeps showing the last drawing that worked until it does."));
            }
        }
        (_, Some(Extracted::Unsupported(t))) => {
            lines.push(format!("Elements are not extracted for {t}."))
        }
        _ => {}
    }
    for l in after
        .links
        .iter()
        .filter(|l| l.from_item == item_id || l.to_item == item_id)
    {
        let status = |b: &BoardData| {
            (
                b.anchored(&l.from_item, l.from_element.as_deref()),
                b.anchored(&l.to_item, l.to_element.as_deref()),
            )
        };
        let was = status(before);
        let now = status(after);
        let text = format!(
            "{} {} {}",
            after.anchor_text(&l.from_item, l.from_element.as_deref()),
            l.link_type,
            after.anchor_text(&l.to_item, l.to_element.as_deref())
        );
        let broken = |s: (Anchored, Anchored)| s.0 == Anchored::Broken || s.1 == Anchored::Broken;
        if broken(now) && !broken(was) {
            // `link` adds a link; it does not move one. Spell out the move,
            // or an agent adds the new link and leaves the broken one.
            let from = after.anchor_text(&l.from_item, l.from_element.as_deref());
            let to = after.anchor_text(&l.to_item, l.to_element.as_deref());
            let swap = |el: &Option<String>, here: &str| match (&renamed, el) {
                (Some((gone, came)), Some(e)) if e == gone && here == item_id => {
                    format!("{}#{came}", after.ref_of(here))
                }
                _ => after.anchor_text(here, el.as_deref()),
            };
            let (new_from, new_to) = (
                swap(&l.from_element, &l.from_item),
                swap(&l.to_element, &l.to_item),
            );
            lines.push(if new_from != from || new_to != to {
                format!(
                    "Link {text} is now broken. To move it to the renamed element: unlink(from: \"{from}\", to: \"{to}\"), then link(from: \"{new_from}\", to: \"{new_to}\", type: \"{}\").",
                    l.link_type
                )
            } else {
                format!(
                    "Link {text} is now broken. To repair it: unlink(from: \"{from}\", to: \"{to}\"), then link it to the element that is meant — or tell your person."
                )
            });
        } else if broken(was) && !broken(now) {
            lines.push(format!("Link {text} is whole again."));
        }
    }
    lines
}

async fn reload(app: &AppState, b: &BoardData) -> Result<BoardData, Fail> {
    BoardData::load(
        &app.db,
        &crate::agent::board::Board {
            id: b.id,
            title: b.title.clone(),
        },
    )
    .await
}

// --- the tools ------------------------------------------------------------------------

async fn item_create(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let kind = arg_str(args, "kind")?;
    let (content, size) = match kind {
        "note" => {
            let source = arg_str(args, "source")?;
            (
                Content {
                    kind: Some("note".into()),
                    asset: None,
                    lang: None,
                    source: Some(source.into()),
                    title: None,
                    tasks: None,
                },
                place::estimate("note", source, 0),
            )
        }
        "diagram" => {
            let source = arg_str(args, "source")?;
            let lang =
                opt_str(args, "lang").unwrap_or(if source.trim_start().starts_with("@start") {
                    "plantuml"
                } else {
                    "mermaid"
                });
            (
                Content {
                    kind: Some("diagram".into()),
                    asset: None,
                    lang: Some(lang.into()),
                    source: Some(source.into()),
                    title: None,
                    tasks: None,
                },
                place::estimate("diagram", source, 0),
            )
        }
        "checklist" => {
            let texts: Vec<String> = args
                .get("tasks")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let tasks: Vec<Task> = texts
                .iter()
                .enumerate()
                .map(|(n, text)| Task {
                    id: format!("t{}", n + 1),
                    text: text.clone(),
                    state: "todo".into(),
                    by: None,
                    by_agent: None,
                    at: None,
                })
                .collect();
            let title = opt_str(args, "title").unwrap_or("").to_string();
            (
                Content {
                    kind: Some("checklist".into()),
                    asset: None,
                    lang: None,
                    source: None,
                    title: Some(title),
                    tasks: Some(tasks),
                },
                place::estimate("checklist", "", texts.len()),
            )
        }
        other => {
            return Err(format!(
                "kind must be note, diagram or checklist, not '{other}'. Images are added by people."
            ));
        }
    };
    // The link is validated before anything is created: nothing or everything.
    let link = match args.get("link").filter(|l| l.is_object()) {
        Some(l) => {
            let (to, element) = b.resolve_anchor(arg_str(l, "to")?, true)?;
            Some((link_type(l, "type")?, anchor(to, element)))
        }
        None => None,
    };
    let at = whereabouts(app, &b, args).await?;
    let spot = place::place(at.target, at.side, size, &obstacles(&b, &[]));
    let item_id = Uuid::now_v7();
    let z = b.items.iter().map(|i| i.z).fold(0.0, f64::max) + 1.0;
    let mut ops = vec![Op::ItemCreate {
        item_id,
        transform: transform(spot),
        z,
        content,
        group_id: None,
        appearance: None,
        crop: None,
    }];
    if let Some(g) = &at.group {
        ops.push(Op::GroupMembers {
            group_id: Uuid::parse_str(g).unwrap(),
            member_ids: Some(group_members(&b, g, &[item_id.to_string()], &[])),
        });
    }
    if let Some((ty, to)) = &link {
        ops.push(Op::LinkAdd {
            link_id: Uuid::now_v7(),
            from: Anchor {
                item_id,
                element: None,
            },
            to: to.clone(),
            link_type: ty.clone(),
            by: None,
            by_agent: None,
            at: None,
        });
    }
    let revision = commit(app, caller, b.id, ops).await?;
    let after = reload(app, &b).await?;
    let made = after
        .item(&item_id.to_string())
        .ok_or("The item was created but could not be read back.")?;
    let mut text = format!(
        "Created {} ({}) {}.",
        made.short_ref(),
        after.kind_of(made),
        at.said
    );
    if let Some((ty, to)) = &link {
        text.push_str(&format!(
            " Linked {} {ty} {}.",
            made.short_ref(),
            after.anchor_text(&to.item_id.to_string(), to.element.as_deref())
        ));
    }
    if made.kind == "diagram"
        && let Some(e) = after.structure(made)
    {
        match e {
            Extracted::Known(s) => {
                text.push_str(&format!(
                    " Elements: {}.",
                    if s.elements.is_empty() {
                        "none".into()
                    } else {
                        s.elements.join(", ")
                    }
                ));
                if let Some((line, why)) = &s.warning {
                    text.push_str(&format!(" ⚠ Line {line} does not parse: {why}."));
                }
            }
            Extracted::Unsupported(t) => {
                text.push_str(&format!(" Elements are not extracted for {t}."))
            }
        }
    }
    if made.kind == "checklist" {
        let list = after.checklist(made)?;
        text.push_str(&format!(
            " Tasks: {}.",
            list.tasks
                .iter()
                .map(|t| format!("{}/{}", made.short_ref(), t.id))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    text.push_str(&format!(" Board is at rev {revision}."));
    let made_ref = made.short_ref();
    Ok(Out::text(text)
        .with(json!({ "ref": made_ref, "revision": made.revision, "boardRevision": revision }))
        .touch(b.id, Some(item_id.to_string()), "editing"))
}

/// Line numbers (1-based) where `needle` starts in `hay`.
fn lines_of(hay: &str, needle: &str) -> Vec<usize> {
    hay.match_indices(needle)
        .map(|(at, _)| hay[..at].matches('\n').count() + 1)
        .collect()
}

async fn stale_message(
    app: &AppState,
    b: &BoardData,
    item: &ItemRow,
    base: i64,
) -> Result<String, Fail> {
    let last: Option<(Option<String>, Option<String>, String, String)> = sqlx::query_as(
        "SELECT actor_id, actor_agent, at, body FROM canvas_operation WHERE canvas_id = ? AND json_extract(body, '$.itemId') = ?
          ORDER BY revision DESC LIMIT 1",
    )
    .bind(b.id.to_string())
    .bind(&item.id)
    .fetch_optional(&app.db)
    .await
    .map_err(db_fail)?;
    let what = last
        .map(|(by, agent, at, body)| {
            let op: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            format!(
                "; last change {} by {}: {}",
                short_time(&at),
                b.credit(by.as_deref(), agent.as_deref()),
                describe(b, &op)
            )
        })
        .unwrap_or_default();
    Ok(format!(
        "{r} changed since rev {base} (it is at rev {now}{what}). Nothing was applied: item_read(ref: \"{r}\") and make the edit again on what is there now.",
        r = item.short_ref(),
        now = item.revision
    ))
}

async fn item_edit(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let item = b.resolve_item(arg_str(args, "ref")?)?;
    if item.kind != "note" && item.kind != "diagram" {
        return Err(format!(
            "{} is a {}; item_edit changes notes and diagrams.{}",
            item.short_ref(),
            item.kind,
            if item.kind == "checklist" {
                " Use tasks for a checklist."
            } else {
                ""
            }
        ));
    }
    let base = arg_i64(args, "base_rev")
        .ok_or("base_rev is required: the revision item_read showed for this item.")?;
    if base != item.revision {
        return Err(stale_message(app, &b, item, base).await?);
    }
    let old = item.body.clone().unwrap_or_default();
    // Flat `old`/`new`, not a nested object: the eval caught a model sending
    // malformed JSON for the nested form.
    let new = match (
        args.get("old")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty()),
        opt_str(args, "source"),
    ) {
        (Some(from), _) => {
            let to = args
                .get("new")
                .and_then(Value::as_str)
                .ok_or("new is required with old (it may be empty).")?;
            let at = lines_of(&old, from);
            match at.len() {
                0 => {
                    return Err(format!(
                        "old does not occur in {}. item_read it and copy the passage exactly, whitespace included.",
                        item.short_ref()
                    ));
                }
                1 => old.replacen(from, to, 1),
                n => {
                    return Err(format!(
                        "old occurs {n} times in {} (lines {}); nothing was changed. Give a longer passage that occurs once.",
                        item.short_ref(),
                        at.iter()
                            .map(usize::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
        }
        (None, Some(source)) => source.to_string(),
        (None, None) => {
            return Err(
                "Give either old and new (one exact passage) or source (the whole text).".into(),
            );
        }
    };
    if new == old {
        return Ok(Out::text(format!(
            "{} already says that; nothing changed.",
            item.short_ref()
        )));
    }
    let item_id = Uuid::parse_str(&item.id).unwrap();
    let op = Op::ItemSource {
        item_id,
        source: new.clone(),
        base_revision: Some(base),
    };
    let revision = match commit(app, caller, b.id, vec![op]).await {
        Ok(r) => r,
        Err(e) if e.contains("changed since this edit began") => {
            let now = reload(app, &b).await?;
            let i = now
                .item(&item.id)
                .ok_or("The item was deleted meanwhile.")?;
            return Err(stale_message(app, &now, i, base).await?);
        }
        Err(e) => return Err(e),
    };
    let after = reload(app, &b).await?;
    let made = after
        .item(&item.id)
        .ok_or("The item was deleted meanwhile.")?;
    let changed = {
        let (o, n): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
        let same = o.iter().zip(&n).take_while(|(a, b)| a == b).count();
        let tail = o
            .iter()
            .rev()
            .zip(n.iter().rev())
            .take_while(|(a, b)| a == b)
            .count()
            .min(o.len().min(n.len()) - same);
        n.len()
            .saturating_sub(same + tail)
            .max(o.len().saturating_sub(same + tail))
    };
    let mut text = format!(
        "Edited {}: {changed} line{} changed; it is now rev {}.",
        made.short_ref(),
        if changed == 1 { "" } else { "s" },
        made.revision
    );
    for line in diagram_effect(&b, &after, &item.id) {
        text.push_str(&format!("\n{line}"));
    }
    Ok(Out::text(text).with(json!({ "ref": made.short_ref(), "revision": made.revision, "boardRevision": revision })).touch(b.id, Some(item.id.clone()), "editing"))
}

fn task_id(r: &str) -> &str {
    r.rsplit('/').next().unwrap_or(r).trim()
}

async fn tasks(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let item = b.resolve_item(arg_str(args, "ref")?)?;
    let list = b.checklist(item)?;
    let item_id = Uuid::parse_str(&item.id).unwrap();
    let r = item.short_ref();
    let exists = |id: &str| list.tasks.iter().any(|t| t.id == id);
    let known = || {
        list.tasks
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut ops = vec![];
    let mut said = vec![];
    if let Some(title) = opt_str(args, "title") {
        ops.push(Op::ChecklistTitle {
            item_id,
            title: title.into(),
        });
        said.push(format!("retitled to \"{title}\""));
    }
    for s in args
        .get("set")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = task_id(arg_str(s, "task")?);
        if !exists(id) {
            return Err(format!(
                "{r} has no task {id}; its tasks are {}. Nothing was changed.",
                known()
            ));
        }
        let state = opt_str(s, "state").map(str::to_string);
        if let Some(st) = &state
            && !TASK_STATES.contains(&st.as_str())
        {
            return Err(format!(
                "Task state '{st}' is not one of {}. Nothing was changed.",
                TASK_STATES.join(", ")
            ));
        }
        let text = opt_str(s, "text").map(str::to_string);
        if state.is_none() && text.is_none() {
            return Err(format!("set {id}: give a state, a text or both."));
        }
        said.push(format!(
            "{r}/{id} → {}",
            [state.clone(), text.clone().map(|t| format!("\"{t}\""))]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(", ")
        ));
        ops.push(Op::TaskSet {
            item_id,
            task_id: id.into(),
            text,
            state,
            by: None,
            by_agent: None,
            at: None,
        });
    }
    // New ids follow the board's own rule: `t` and one past the highest number.
    // Adds go before removes, and each position is taken from the list as the
    // adds before it left it, which is how the server applies them in order.
    let mut order: Vec<String> = list.tasks.iter().map(|t| t.id.clone()).collect();
    let mut next = list
        .tasks
        .iter()
        .filter_map(|t| t.id.strip_prefix('t').and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0);
    for a in args
        .get("add")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let text = arg_str(a, "text")?;
        let state = opt_str(a, "state").unwrap_or("todo");
        if !TASK_STATES.contains(&state) {
            return Err(format!(
                "Task state '{state}' is not one of {}.",
                TASK_STATES.join(", ")
            ));
        }
        next += 1;
        let id = format!("t{next}");
        let index = match opt_str(a, "after") {
            Some(after) => {
                let after = task_id(after);
                let at = order.iter().position(|t| t == after).ok_or_else(|| {
                    format!(
                        "{r} has no task {after} to add after; its tasks are {}.",
                        known()
                    )
                })? + 1;
                order.insert(at, id.clone());
                Some(at)
            }
            None => {
                order.push(id.clone());
                None
            }
        };
        said.push(format!("added {r}/{id} \"{text}\""));
        ops.push(Op::TaskAdd {
            item_id,
            task: Task {
                id,
                text: text.into(),
                state: state.into(),
                by: None,
                by_agent: None,
                at: None,
            },
            index,
        });
    }
    for rm in args
        .get("remove")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = task_id(rm.as_str().unwrap_or(""));
        if !exists(id) {
            return Err(format!(
                "{r} has no task {id}; its tasks are {}. Nothing was changed.",
                known()
            ));
        }
        said.push(format!("removed {r}/{id}"));
        ops.push(Op::TaskRemove {
            item_id,
            task_id: id.into(),
        });
    }
    if ops.is_empty() {
        return Err("Nothing to do: give add, set, remove or title.".into());
    }
    let revision = commit(app, caller, b.id, ops).await?;
    let after = reload(app, &b).await?;
    let now = after.checklist(
        after
            .item(&item.id)
            .ok_or("The checklist was deleted meanwhile.")?,
    )?;
    let done = now.tasks.iter().filter(|t| t.state == "done").count();
    let text = format!(
        "{}.\n{r} is now {done}/{} done; board at rev {revision}.",
        said.join("; "),
        now.tasks.len()
    );
    Ok(Out::text(text)
        .with(json!({ "ref": r, "boardRevision": revision }))
        .touch(b.id, Some(item.id.clone()), "editing"))
}

async fn link(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let (from, from_el) = b.resolve_anchor(arg_str(args, "from")?, true)?;
    let (to, to_el) = b.resolve_anchor(arg_str(args, "to")?, true)?;
    let ty = link_type(args, "type")?;
    if from.id == to.id && from_el == to_el {
        return Err("A link needs two different ends.".into());
    }
    let existing = b.links.iter().find(|l| {
        l.from_item == from.id
            && l.to_item == to.id
            && l.from_element == from_el
            && l.to_element == to_el
    });
    let label = format!(
        "{} {ty} {}",
        b.anchor_text(&from.id, from_el.as_deref()),
        b.anchor_text(&to.id, to_el.as_deref())
    );
    let (op, said) = match existing {
        Some(l) if l.link_type == ty => {
            return Ok(Out::text(format!(
                "{label} already exists; nothing changed."
            )));
        }
        Some(l) => (
            Op::LinkSet {
                link_id: Uuid::parse_str(&l.id).unwrap(),
                link_type: ty.clone(),
            },
            format!(
                "Changed the link's type from {} to {ty}: {label}.",
                l.link_type
            ),
        ),
        None => (
            Op::LinkAdd {
                link_id: Uuid::now_v7(),
                from: anchor(from, from_el.clone()),
                to: anchor(to, to_el.clone()),
                link_type: ty.clone(),
                by: None,
                by_agent: None,
                at: None,
            },
            format!("Linked {label}."),
        ),
    };
    let revision = commit(app, caller, b.id, vec![op]).await?;
    Ok(Out::text(format!("{said} Board at rev {revision}."))
        .with(json!({ "boardRevision": revision }))
        .touch(b.id, Some(from.id.clone()), "editing"))
}

async fn unlink(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let (a, a_el) = b.resolve_anchor(arg_str(args, "from")?, false)?;
    let (z, z_el) = b.resolve_anchor(arg_str(args, "to")?, false)?;
    let end = |item: &str, el: &Option<String>, want: &ItemRow, want_el: &Option<String>| {
        item == want.id && (want_el.is_none() || el == want_el)
    };
    let gone: Vec<_> = b
        .links
        .iter()
        .filter(|l| {
            (end(&l.from_item, &l.from_element, a, &a_el)
                && end(&l.to_item, &l.to_element, z, &z_el))
                || (end(&l.from_item, &l.from_element, z, &z_el)
                    && end(&l.to_item, &l.to_element, a, &a_el))
        })
        .collect();
    if gone.is_empty() {
        let of_a: Vec<String> = b
            .links
            .iter()
            .filter(|l| l.from_item == a.id || l.to_item == a.id)
            .map(|l| {
                format!(
                    "{} {} {}",
                    b.anchor_text(&l.from_item, l.from_element.as_deref()),
                    l.link_type,
                    b.anchor_text(&l.to_item, l.to_element.as_deref())
                )
            })
            .collect();
        return Err(format!(
            "No link joins those two. {}'s links: {}.",
            a.short_ref(),
            if of_a.is_empty() {
                "none".into()
            } else {
                of_a.join("; ")
            }
        ));
    }
    let said: Vec<String> = gone
        .iter()
        .map(|l| {
            format!(
                "{} {} {}",
                b.anchor_text(&l.from_item, l.from_element.as_deref()),
                l.link_type,
                b.anchor_text(&l.to_item, l.to_element.as_deref())
            )
        })
        .collect();
    let ops = gone
        .iter()
        .map(|l| Op::LinkDelete {
            link_id: Uuid::parse_str(&l.id).unwrap(),
        })
        .collect();
    let revision = commit(app, caller, b.id, ops).await?;
    Ok(Out::text(format!(
        "Removed {}. Board at rev {revision}.",
        said.join("; ")
    ))
    .with(json!({ "boardRevision": revision }))
    .touch(b.id, Some(a.id.clone()), "editing"))
}

async fn arrange(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let refs: Vec<&str> = args
        .get("refs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if refs.is_empty() {
        return Err("refs is required: the items to move, e.g. [\"n3\", \"n4\"].".into());
    }
    let items: Vec<&ItemRow> = refs
        .iter()
        .map(|r| b.resolve_item(r))
        .collect::<Result<_, _>>()?;
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    let mut ops = vec![];
    let mut said = vec![];
    if args.get("out_of_group").and_then(Value::as_bool) == Some(true) {
        let mut groups: Vec<&str> = items.iter().filter_map(|i| i.group_id.as_deref()).collect();
        groups.dedup();
        for g in groups {
            ops.push(Op::GroupMembers {
                group_id: Uuid::parse_str(g).unwrap(),
                member_ids: Some(group_members(&b, g, &[], &ids)),
            });
        }
        said.push("taken out of their groups".to_string());
    }
    let named = ["near", "below", "right_of", "in"]
        .iter()
        .any(|k| opt_str(args, k).is_some());
    if named {
        let at = whereabouts(app, &b, args).await?;
        let mut taken = obstacles(&b, &ids);
        let mut target = at.target;
        for i in &items {
            let spot = place::place(
                target,
                if at.side == Side::Near && target != at.target {
                    Side::Below
                } else {
                    at.side
                },
                (i.width, i.height),
                &taken,
            );
            taken.push(spot);
            // The next item goes after this one, so a set stays together.
            if at.side != Side::In {
                target = spot;
            }
            let crop = None;
            ops.push(Op::ItemTransform {
                item_id: Uuid::parse_str(&i.id).unwrap(),
                transform: Transform {
                    rotation: i.rotation,
                    ..transform(spot)
                },
                crop,
            });
        }
        if let Some(g) = &at.group {
            let add: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
            ops.push(Op::GroupMembers {
                group_id: Uuid::parse_str(g).unwrap(),
                member_ids: Some(group_members(&b, g, &add, &ids)),
            });
        }
        said.push(format!("moved {}", at.said));
    }
    if ops.is_empty() {
        return Err("Say where: near, below, right_of or in — or out_of_group: true.".into());
    }
    let revision = commit(app, caller, b.id, ops).await?;
    let names: Vec<String> = items.iter().map(|i| i.short_ref()).collect();
    Ok(Out::text(format!(
        "{}: {}. Board at rev {revision}.",
        names.join(", "),
        said.join(", ")
    ))
    .with(json!({ "boardRevision": revision }))
    .touch(b.id, items.first().map(|i| i.id.clone()), "editing"))
}

async fn item_delete(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let board = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = BoardData::load(&app.db, &board).await?;
    let item = b.resolve_item(arg_str(args, "ref")?)?;
    let links: Vec<_> = b
        .links
        .iter()
        .filter(|l| l.from_item == item.id || l.to_item == item.id)
        .collect();
    let said: Vec<String> = links
        .iter()
        .map(|l| {
            format!(
                "{} {} {}",
                b.anchor_text(&l.from_item, l.from_element.as_deref()),
                l.link_type,
                b.anchor_text(&l.to_item, l.to_element.as_deref())
            )
        })
        .collect();
    // Links first, then the item: the same batch a person's delete sends.
    let mut ops: Vec<Op> = links
        .iter()
        .map(|l| Op::LinkDelete {
            link_id: Uuid::parse_str(&l.id).unwrap(),
        })
        .collect();
    ops.push(Op::ItemDelete {
        item_id: Uuid::parse_str(&item.id).unwrap(),
    });
    let revision = commit(app, caller, b.id, ops).await?;
    let mut text = format!(
        "Deleted {} ({} \"{}\")",
        item.short_ref(),
        b.kind_of(item),
        b.title_of(item)
    );
    text.push_str(&if said.is_empty() {
        " and no links".into()
    } else {
        format!(
            " and its link{}: {}",
            if said.len() == 1 { "" } else { "s" },
            said.join("; ")
        )
    });
    text.push_str(&format!(". Board at rev {revision}."));
    if let Some(body) = item.body.as_deref().filter(|_| item.kind != "image") {
        text.push_str(&format!(
            "\nIts content, should it need recreating:\n```\n{body}\n```"
        ));
    }
    Ok(Out::text(text).with(json!({ "boardRevision": revision })))
}
