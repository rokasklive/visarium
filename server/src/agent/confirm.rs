//! Asking the agent's person before a tool acts, through the client, as a
//! multi-round-trip request (MCP 2026-07-28): the first call answers
//! `input_required` with a form elicitation, and the client retries the call
//! with the person's answer in `params.inputResponses`. No state is kept
//! between the two calls; the retry is validated again from scratch.
//! `board_delete` and the decision guard (agents/board-editing) both ask this
//! way, each under its own `inputResponses` key.

use serde_json::{Value, json};

use crate::agent::Out;

/// A tool's answer: done, or a question for the person first.
pub enum Step {
    Done(Out),
    /// A complete `input_required` result, sent as is. Never remembered under
    /// the call's `request_id`, so the retry with the answer is not cut short.
    Ask(Value),
}

/// Whether the client said, on this request, that it can show a form.
pub fn can_ask(params: &Value) -> bool {
    params
        .pointer("/_meta/io.modelcontextprotocol~1clientCapabilities/elicitation")
        .and_then(Value::as_object)
        // `{}` is form only; with modes listed, form must be one of them.
        .is_some_and(|modes| modes.is_empty() || modes.contains_key("form"))
}

pub enum Answer {
    Yes,
    /// Anything but an explicit yes, with what the client answered
    /// (`decline`, `cancel`, `accept`, or `nothing`).
    No(String),
}

/// The answer under `key`, once the client has retried with one.
pub fn answer(params: &Value, key: &str) -> Option<Answer> {
    let answer = params.pointer(&format!("/inputResponses/{key}"))?;
    let action = answer.get("action").and_then(Value::as_str).unwrap_or("");
    let yes = action == "accept"
        && answer.pointer("/content/confirm").and_then(Value::as_bool) == Some(true);
    Some(if yes {
        Answer::Yes
    } else {
        Answer::No(if action.is_empty() { "nothing" } else { action }.to_string())
    })
}

/// An `input_required` result asking one yes/no question under `key`.
/// `fallback` is for a client that does not read `resultType`: something
/// true to say, with nothing done.
pub fn ask(key: &str, message: &str, title: &str, fallback: &str) -> Step {
    Step::Ask(json!({
        "resultType": "input_required",
        "inputRequests": { key: {
            "method": "elicitation/create",
            "params": {
                "mode": "form",
                "message": message,
                "requestedSchema": {
                    "type": "object",
                    "properties": { "confirm": { "type": "boolean", "title": title, "default": false } },
                    "required": ["confirm"],
                },
            },
        } },
        "content": [{ "type": "text", "text": fallback }],
        "isError": false,
    }))
}
