//! Board management tools (agents/board-management): create, rename,
//! duplicate and delete a board. They run only with the *Manage boards* grant,
//! which `mod.rs` checks before getting here, and they go through the same
//! board operations as the app, so the two cannot disagree on permissions.
//!
//! Deleting asks the agent's person first, through the client, as a
//! multi-round-trip request (MCP 2026-07-28): the first call answers
//! `input_required` with a form elicitation, and the client retries the call
//! with the person's answer in `params.inputResponses`. See design.md for why
//! no `requestState` is kept.

use serde_json::{Value, json};

use crate::AppState;
use crate::agent::board::{Fail, db_fail, find_board};
use crate::agent::write::{remember, remembered};
use crate::agent::{Caller, Out, arg_str, opt_str};
use crate::boards;

/// The key the confirmation travels under, both ways.
const CONFIRM: &str = "confirm_delete";

/// A board tool's answer: done, or a question for the person first.
pub enum Step {
    Done(Out),
    /// A complete `input_required` result, sent as is.
    Ask(Value),
}

pub async fn run(app: &AppState, caller: &Caller, tool: &str, params: &Value) -> Result<Step, Fail> {
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    if let Err(wait) = app.agent_writes.take(&caller.key()) {
        return Err(format!(
            "Too many changes from this agent in one minute (the limit is {}). Wait {wait} seconds, then continue.",
            crate::agent::AGENT_WRITES_PER_MINUTE
        ));
    }
    if tool == "board_delete" {
        return delete(app, caller, &args, params).await;
    }
    if let Some(earlier) = remembered(app, caller, &args).await? {
        return Ok(Step::Done(earlier));
    }
    let out = match tool {
        "board_create" => create(app, caller, &args).await?,
        "board_rename" => rename(app, caller, &args).await?,
        _ => duplicate(app, caller, &args).await?,
    };
    remember(app, caller, &args, &out).await?;
    Ok(Step::Done(out))
}

/// "Claude for Rokas": how people are told who did it.
fn by(caller: &Caller) -> String {
    format!("{} for {}", caller.agent, caller.user.display_name)
}

/// A note when other boards share this title, since then only the id names it.
async fn shared_title(app: &AppState, id: &str, title: &str) -> Result<String, Fail> {
    let others: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas WHERE lower(title) = lower(?) AND id <> ?")
        .bind(title)
        .bind(id)
        .fetch_one(&app.db)
        .await
        .map_err(db_fail)?;
    Ok(if others > 0 {
        format!(
            "\nAnother board is also called \"{title}\" ({others} in all besides this one), so name this one by its id: {id}."
        )
    } else {
        String::new()
    })
}

async fn create(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let title = arg_str(args, "title")?;
    let b = boards::create_board(app, &caller.user.id, title, Some(&caller.agent))
        .await
        .map_err(|e| e.detail)?;
    let note = shared_title(app, &b.id, &b.title).await?;
    Ok(Out::text(format!(
        "Created board \"{}\" (id {}), owned by {}. It is empty: add items with item_create(board: \"{}\").{note}",
        b.title, b.id, caller.user.display_name, b.id
    ))
    .with(json!({ "id": b.id, "title": b.title })))
}

async fn rename(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let found = find_board(&app.db, arg_str(args, "board")?).await?;
    let title = arg_str(args, "title")?;
    let b = boards::rename_board(app, &found.id, title, &by(caller))
        .await
        .map_err(|e| e.detail)?;
    let note = shared_title(app, &b.id, &b.title).await?;
    Ok(Out::text(format!(
        "Renamed \"{}\" to \"{}\" (id {}). People on the board see the new title.{note}",
        found.title, b.title, b.id
    ))
    .with(json!({ "id": b.id, "title": b.title, "was": found.title })))
}

async fn duplicate(app: &AppState, caller: &Caller, args: &Value) -> Result<Out, Fail> {
    let found = find_board(&app.db, arg_str(args, "board")?).await?;
    let b = boards::duplicate_board(
        app,
        &found.id,
        &caller.user.id,
        opt_str(args, "title").map(str::to_string),
        Some(&caller.agent),
    )
    .await
    .map_err(|e| e.detail)?;
    let note = shared_title(app, &b.id, &b.title).await?;
    Ok(Out::text(format!(
        "Duplicated \"{}\" as \"{}\" (id {}), owned by {}. Items keep their refs: d2 in the copy is the copy of d2.{note}",
        found.title, b.title, b.id, caller.user.display_name
    ))
    .with(json!({ "id": b.id, "title": b.title, "from": found.id })))
}

/// What a board holds, in words: "3 diagrams, 4 notes and 1 checklist".
async fn holdings(app: &AppState, board: &str) -> Result<String, Fail> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT kind, count(*) FROM canvas_item WHERE canvas_id = ? GROUP BY kind ORDER BY kind")
            .bind(board)
            .fetch_all(&app.db)
            .await
            .map_err(db_fail)?;
    if rows.is_empty() {
        return Ok("nothing: it is empty".into());
    }
    let words: Vec<String> = rows
        .iter()
        .map(|(kind, n)| format!("{n} {kind}{}", if *n == 1 { "" } else { "s" }))
        .collect();
    Ok(match words.as_slice() {
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        [] => unreachable!(),
    })
}

/// Whether the client said, on this request, that it can show a form.
fn can_ask(params: &Value) -> bool {
    params
        .pointer("/_meta/io.modelcontextprotocol~1clientCapabilities/elicitation")
        .and_then(Value::as_object)
        // `{}` is form only; with modes listed, form must be one of them.
        .is_some_and(|modes| modes.is_empty() || modes.contains_key("form"))
}

async fn delete(app: &AppState, caller: &Caller, args: &Value, params: &Value) -> Result<Step, Fail> {
    let found = find_board(&app.db, arg_str(args, "board")?).await?;
    let board = boards::board(app, &found.id).await.map_err(|e| e.detail)?;
    if boards::may_delete(&caller.user, &board).is_err() {
        return Err(format!(
            "Only the board's owner or an admin can delete \"{}\", and {} is neither. Nothing was deleted.",
            board.title, caller.user.display_name
        ));
    }
    if !can_ask(params) {
        return Err(format!(
            "Deleting a board needs {}'s confirmation, and this client did not say it can ask them (no form elicitation capability). Nothing was deleted. {} can delete \"{}\" in the Visarium app.",
            caller.user.display_name, caller.user.display_name, board.title
        ));
    }
    let answer = params.pointer(&format!("/inputResponses/{CONFIRM}"));
    let Some(answer) = answer else {
        let holds = holdings(app, &board.id).await?;
        let message = format!(
            "{} wants to delete the board \"{}\", which holds {holds}. Deleting cannot be undone.",
            by(caller),
            board.title
        );
        return Ok(Step::Ask(json!({
            "resultType": "input_required",
            "inputRequests": { CONFIRM: {
                "method": "elicitation/create",
                "params": {
                    "mode": "form",
                    "message": message,
                    "requestedSchema": {
                        "type": "object",
                        "properties": { "confirm": { "type": "boolean", "title": format!("Delete \"{}\" for good", board.title), "default": false } },
                        "required": ["confirm"],
                    },
                },
            } },
            // For a client that does not read `resultType`: something true to
            // say, and nothing deleted.
            "content": [{ "type": "text", "text": format!(
                "Asked {} to confirm deleting \"{}\". Nothing is deleted until they confirm. If no question reached them, this client cannot ask; they can delete the board in the Visarium app.",
                caller.user.display_name, board.title
            ) }],
            "isError": false,
        })));
    };
    let action = answer.get("action").and_then(Value::as_str).unwrap_or("");
    let confirmed = action == "accept" && answer.pointer("/content/confirm").and_then(Value::as_bool) == Some(true);
    if !confirmed {
        // Say only what came back: a client can decline without showing the
        // person anything, so "they declined" would not always be true.
        return Ok(Step::Done(Out::text(format!(
            "Deleting \"{}\" was not confirmed: your client answered \"{}\". Nothing was deleted. If {} says they were not asked, this client cannot show the question; they can delete the board in the Visarium app.",
            board.title,
            if action.is_empty() { "nothing" } else { action },
            caller.user.display_name,
        ))));
    }
    let holds = holdings(app, &board.id).await?;
    boards::delete_board(app, &board, &by(caller)).await.map_err(|e| e.detail)?;
    Ok(Step::Done(
        Out::text(format!(
            "Deleted the board \"{}\" (id {}), which held {holds}, with {}'s confirmation. People who had it open were told.",
            board.title, board.id, caller.user.display_name
        ))
        .with(json!({ "deleted": board.id })),
    ))
}
