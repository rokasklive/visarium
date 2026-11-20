//! The board socket: presence, cursors, selections, transform previews and
//! advisory item locks — everything ephemeral. Durable changes go over REST
//! and are only *announced* here, after they commit (ADR-0017, ADR-0019).
//!
//! Share-link viewers (ADR-0026) join a room as listeners: they hear
//! committed operations and nothing else — no presence, cursors or names —
//! and everything they send but `hello` is ignored. Members hear only how many
//! of them there are (`{"t":"viewers","count":n}`, which older clients drop).
//!
//! Wire format: docs/architecture/REALTIME_COLLABORATION.md and
//! packages/canvas-core/src/protocol.ts. Close codes: 1007 for a malformed
//! frame, 1008 for a refused one (wrong protocol, unknown board), 1011 for a
//! connection too slow to keep up — the client resyncs from the snapshot.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};
use tracing::Instrument;
use uuid::Uuid;

use crate::auth::User;
use crate::boards::{self, Op};
use crate::error::ApiError;
use crate::sharing::ShareLink;
use crate::{AppState, PROTOCOL_VERSION};

const COLOUR_SLOTS: usize = 6;
const MAX_FRAME_ITEMS: usize = 1024;
const LOCK_TTL_MS: u64 = 10_000;
/// Frames queued for one connection before it is cut off as too slow.
const SEND_QUEUE: usize = 512;
/// An agent leaves a board's participants after this long without a call
/// (ADR-0031). A hypothesis; see OPEN_QUESTIONS.md.
pub const AGENT_QUIET_SECS: u64 = 60;

const BAD_DATA: u16 = 1007;
const POLICY_VIOLATION: u16 = 1008;
const SERVER_ERROR: u16 = 1011;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

struct Actor {
    id: Uuid,
    display_name: String,
    colour: usize,
    tx: mpsc::Sender<Message>,
    too_slow: Arc<Notify>,
}

impl Actor {
    fn presence(&self) -> Value {
        json!({ "actorId": self.id, "displayName": self.display_name, "colourIndex": self.colour })
    }
    /// Never blocks the room. A full queue means the client has fallen behind,
    /// and a client that silently missed frames is worse than one that knows
    /// to reconnect and resync.
    fn send(&self, text: &Utf8Bytes) {
        if let Err(mpsc::error::TrySendError::Full(_)) =
            self.tx.try_send(Message::Text(text.clone()))
        {
            self.too_slow.notify_one();
        }
    }
}

/// A share-link viewer: receives `op` frames, sends nothing that matters.
struct Viewer {
    id: Uuid,
    share_id: String,
    tx: mpsc::Sender<Message>,
    too_slow: Arc<Notify>,
}

struct Lock {
    actor: Uuid,
    expires_at: u64,
}

/// An agent working on a board: a participant with no socket, present while
/// its tool calls keep coming (agents/presence).
struct AgentPresence {
    id: Uuid,
    name: String,
    person: String,
    colour: usize,
    last_ms: u64,
}

impl AgentPresence {
    fn presence(&self) -> Value {
        json!({ "actorId": self.id, "displayName": self.name, "colourIndex": self.colour, "kind": "agent", "person": self.person })
    }
}

#[derive(Default)]
struct Room {
    actors: Vec<Actor>,
    viewers: Vec<Viewer>,
    locks: HashMap<Uuid, Lock>,
    agents: Vec<AgentPresence>,
}

impl Room {
    fn broadcast(&self, except: Option<Uuid>, frame: &Value) {
        let text = Utf8Bytes::from(frame.to_string());
        for a in self.actors.iter().filter(|a| Some(a.id) != except) {
            a.send(&text);
        }
    }
    fn viewer_count(&self) -> Value {
        json!({ "t": "viewers", "count": self.viewers.len() })
    }
    /// A colour for someone shown by `letter` (canvas/presence-indicators): the
    /// first no participant with the same letter holds, so no two tiles on the
    /// board match. Different letters may share a colour. When every colour is
    /// taken for that letter, the least used one.
    fn free_colour(&self, letter: char) -> usize {
        let held: Vec<(char, usize)> = self
            .actors
            .iter()
            .map(|a| (letter_of(&a.display_name), a.colour))
            .chain(self.agents.iter().map(|a| (letter_of(&a.name), a.colour)))
            .collect();
        (0..COLOUR_SLOTS)
            .find(|s| !held.iter().any(|(l, c)| *l == letter && c == s))
            .unwrap_or_else(|| {
                (0..COLOUR_SLOTS)
                    .min_by_key(|s| held.iter().filter(|(_, c)| c == s).count())
                    .unwrap_or(0)
            })
    }
    fn send_to(&self, actor: Uuid, frame: &Value) {
        if let Some(a) = self.actors.iter().find(|a| a.id == actor) {
            a.send(&Utf8Bytes::from(frame.to_string()));
        }
    }
}

/// Every board with someone on it. ponytail: one mutex for all rooms; sends
/// inside it never block, so contention is a few microseconds per frame.
/// Per-room locks if a single node ever hosts enough boards to notice.
#[derive(Default)]
pub struct Rooms(Mutex<HashMap<Uuid, Room>>);

impl Rooms {
    /// Broadcast a committed batch to everyone but its author.
    pub fn announce(&self, board: &Uuid, author: Option<Uuid>, from: i64, to: i64, ops: &[Op]) {
        let rooms = self.0.lock().unwrap();
        if let Some(room) = rooms.get(board) {
            let frame =
                json!({ "t": "op", "fromRevision": from, "toRevision": to, "operations": ops });
            room.broadcast(author, &frame);
            let text = Utf8Bytes::from(frame.to_string());
            for v in &room.viewers {
                if let Err(mpsc::error::TrySendError::Full(_)) =
                    v.tx.try_send(Message::Text(text.clone()))
                {
                    v.too_slow.notify_one();
                }
            }
        }
    }

    /// An agent called a tool on this board. Joins it to the participants if
    /// it was not there, and shows what it touched. Only members hear either:
    /// `broadcast` reaches actors, never share-link viewers (ADR-0026). A board
    /// nobody has open has no room, and there is no one to tell.
    pub fn agent_seen(
        &self,
        board: &Uuid,
        id: Uuid,
        name: &str,
        person: &str,
        item: Option<&str>,
        verb: &str,
    ) {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(board) else {
            return;
        };
        let now = now_ms();
        match room.agents.iter_mut().find(|a| a.id == id) {
            Some(a) => a.last_ms = now,
            None => {
                let colour = room.free_colour(letter_of(name));
                let agent = AgentPresence {
                    id,
                    name: name.to_string(),
                    person: person.to_string(),
                    colour,
                    last_ms: now,
                };
                room.broadcast(
                    None,
                    &json!({ "t": "presence", "joined": [agent.presence()] }),
                );
                room.agents.push(agent);
            }
        }
        if let Some(item) = item.and_then(|i| Uuid::parse_str(i).ok()) {
            room.broadcast(
                None,
                &json!({ "t": "focus", "actorId": id, "itemId": item, "verb": verb }),
            );
        }
    }

    /// A board's new title, and who gave it. Members only: a viewer learns no
    /// names (ADR-0026).
    pub fn board_renamed(&self, board: &Uuid, title: &str, by: &str) {
        let rooms = self.0.lock().unwrap();
        if let Some(room) = rooms.get(board) {
            room.broadcast(None, &json!({ "t": "board", "title": title, "by": by }));
        }
    }

    /// The board is gone. Members hear who deleted it; viewers are cut off,
    /// since their link went with it.
    pub fn board_deleted(&self, board: &Uuid, by: &str) {
        let rooms = self.0.lock().unwrap();
        if let Some(room) = rooms.get(board) {
            room.broadcast(None, &json!({ "t": "board-deleted", "by": by }));
            for v in &room.viewers {
                let _ =
                    v.tx.try_send(close_message(POLICY_VIOLATION, "this board was deleted"));
            }
        }
    }

    /// Drops agents quiet for longer than AGENT_QUIET_SECS.
    pub fn sweep_agents(&self) {
        self.sweep_agents_at(now_ms());
    }

    /// The sweep as of `now` (milliseconds since the epoch), for tests.
    pub fn sweep_agents_at(&self, now: u64) {
        let cutoff = now.saturating_sub(AGENT_QUIET_SECS * 1000);
        let mut rooms = self.0.lock().unwrap();
        for room in rooms.values_mut() {
            let gone: Vec<Uuid> = room
                .agents
                .iter()
                .filter(|a| a.last_ms < cutoff)
                .map(|a| a.id)
                .collect();
            if !gone.is_empty() {
                room.agents.retain(|a| a.last_ms >= cutoff);
                room.broadcast(None, &json!({ "t": "presence", "left": gone }));
            }
        }
    }

    fn with<R>(&self, board: &Uuid, f: impl FnOnce(&mut Room) -> R) -> R {
        let mut rooms = self.0.lock().unwrap();
        f(rooms.entry(*board).or_default())
    }

    fn leave(&self, board: &Uuid, actor: Uuid) {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(board) else {
            return;
        };
        room.actors.retain(|a| a.id != actor);
        let released: Vec<Uuid> = room
            .locks
            .iter()
            .filter(|(_, l)| l.actor == actor)
            .map(|(id, _)| *id)
            .collect();
        for id in &released {
            room.locks.remove(id);
        }
        if !released.is_empty() {
            room.broadcast(Some(actor), &release_frame(&released));
        }
        room.broadcast(Some(actor), &json!({ "t": "presence", "left": [actor] }));
        if room.actors.is_empty() && room.viewers.is_empty() {
            rooms.remove(board);
        }
    }

    fn join_viewer(&self, board: &Uuid, viewer: Viewer) {
        self.with(board, |r| {
            r.viewers.push(viewer);
            r.broadcast(None, &r.viewer_count());
        });
    }

    fn leave_viewer(&self, board: &Uuid, id: Uuid) {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(board) else {
            return;
        };
        room.viewers.retain(|v| v.id != id);
        room.broadcast(None, &room.viewer_count());
        if room.actors.is_empty() && room.viewers.is_empty() {
            rooms.remove(board);
        }
    }

    /// Disconnects every viewer holding this link: it was revoked, or its
    /// passphrase changed.
    pub fn close_share(&self, share_id: &str) {
        let rooms = self.0.lock().unwrap();
        for v in rooms
            .values()
            .flat_map(|r| &r.viewers)
            .filter(|v| v.share_id == share_id)
        {
            // A full queue: the viewer is already being dropped as too slow.
            let _ = v.tx.try_send(close_message(
                POLICY_VIOLATION,
                "this link is no longer active",
            ));
        }
    }
}

/// The letter a participant's tile shows: the first character of the name,
/// folded to its base letter ("Šarūnas" → S) and uppercased; `?` for anything
/// the tile cannot draw. The web client's `letterOf` is the same rule, and
/// `packages/canvas-core/fixtures/presence-letters.json` holds both to it.
pub fn letter_of(name: &str) -> char {
    use unicode_normalization::UnicodeNormalization;
    name.trim()
        .chars()
        .next()
        .and_then(|c| c.nfd().next())
        .and_then(|c| c.to_uppercase().next())
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .unwrap_or('?')
}

fn release_frame(ids: &[Uuid]) -> Value {
    json!({ "t": "lock", "itemIds": ids, "heldBy": null, "expiresAt": 0 })
}

/// Same-origin only: the socket authenticates by cookie, so without this any
/// page the user visits could open one as them (cross-site WebSocket hijack).
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        return true;
    };
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|h| h.to_str().ok());
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest.trim_end_matches('/'));
    matches!((origin_host, host), (Some(o), Some(h)) if o.eq_ignore_ascii_case(h))
}

pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
    axum::Extension(user): axum::Extension<User>,
    Path(board): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !same_origin(&headers) {
        return ApiError::forbidden("cross-origin socket refused").into_response();
    }
    ws.max_message_size(1024 * 1024).on_upgrade(move |socket| {
        let span =
            tracing::info_span!("ws", conn = %Uuid::now_v7(), board = %board, user = %user.id);
        run(app, socket, board, user.display_name).instrument(span)
    })
}

struct Close(u16, String);

fn invalid(reason: impl Into<String>) -> Close {
    Close(BAD_DATA, reason.into())
}

async fn run(app: AppState, socket: WebSocket, board: String, display_name: String) {
    let (mut sink, mut stream) = socket.split();
    let board = match Uuid::parse_str(&board) {
        Ok(id) if boards::exists(&app.db, &id).await.unwrap_or(false) => id,
        _ => {
            tracing::debug!(reason = "unknown board", "socket refused");
            // The client may already be gone; it is refused either way.
            let _ = sink
                .send(close_message(POLICY_VIOLATION, "unknown board"))
                .await;
            return;
        }
    };

    let (tx, rx) = mpsc::channel::<Message>(SEND_QUEUE);
    let too_slow = Arc::new(Notify::new());
    let writer = spawn_writer(sink, rx, too_slow.clone());
    let opened = std::time::Instant::now();
    tracing::info!("socket opened");
    let mut from_client = None;

    let mut connection = Connection {
        app: app.clone(),
        board,
        display_name,
        actor: None,
        tx: tx.clone(),
        too_slow,
    };
    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(frame) => {
                from_client = Some(close_of(frame.as_ref()));
                break;
            }
            _ => continue,
        };
        if let Err(Close(code, reason)) = connection.handle(&text).await {
            // If the writer is gone, so is the client: nothing to tell.
            let _ = tx.send(close_message(code, &reason)).await;
            break;
        }
        if writer.is_finished() {
            break;
        }
    }
    if let Some(actor) = connection.actor {
        app.rooms.leave(&board, actor);
    }
    drop(connection);
    drop(tx);
    log_closed(writer.await.ok().flatten(), from_client, opened);
}

/// The code and reason of a close frame, 1005 when it carried none.
fn close_of(frame: Option<&CloseFrame>) -> (u16, String) {
    frame.map_or((1005, String::new()), |f| (f.code, f.reason.to_string()))
}

/// One line per socket: who closed it, how, and after how long.
fn log_closed(
    from_server: Option<(u16, String)>,
    from_client: Option<(u16, String)>,
    opened: std::time::Instant,
) {
    let duration_ms = opened.elapsed().as_millis() as u64;
    let (by, (code, reason)) = match (from_server, from_client) {
        (Some(close), _) => ("server", close),
        (None, Some(close)) => ("client", close),
        // 1006: gone without a close frame (a dropped network, a killed tab).
        (None, None) => ("network", (1006, String::new())),
    };
    tracing::info!(by, code, reason, duration_ms, "socket closed");
}

/// Drains a connection's queue into its socket; ends it when the client falls
/// too far behind or a close frame goes out, and answers the close it sent.
fn spawn_writer(
    mut sink: futures_util::stream::SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<Message>,
    too_slow: Arc<Notify>,
) -> tokio::task::JoinHandle<Option<(u16, String)>> {
    tokio::spawn(
        async move {
            loop {
                tokio::select! {
                    message = rx.recv() => {
                        let message = message?;
                        let closing = match &message {
                            Message::Close(frame) => Some(close_of(frame.as_ref())),
                            _ => None,
                        };
                        if sink.send(message).await.is_err() || closing.is_some() {
                            return closing;
                        }
                    }
                    _ = too_slow.notified() => {
                        tracing::warn!(reason = "too slow", "dropping a client that fell behind");
                        // Gone or not, the socket is closed from here on.
                        let _ = sink.send(close_message(SERVER_ERROR, "too slow; resync")).await;
                        return Some((SERVER_ERROR, "too slow; resync".into()));
                    }
                }
            }
        }
        .in_current_span(),
    )
}

// --- share-link viewers ------------------------------------------------------

/// How often an open viewer socket rechecks its link, so one that expires
/// while open is closed within this long.
const VIEWER_RECHECK_SECS: u64 = 60;

pub async fn upgrade_viewer(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
    axum::Extension(link): axum::Extension<ShareLink>,
    headers: HeaderMap,
) -> Response {
    if !same_origin(&headers) {
        return ApiError::forbidden("cross-origin socket refused").into_response();
    }
    ws.max_message_size(16 * 1024)
        .on_upgrade(move |socket| {
            let span = tracing::info_span!("ws", conn = %Uuid::now_v7(), board = %link.canvas_id, share = %link.id);
            run_viewer(app, socket, link).instrument(span)
        })
}

async fn run_viewer(app: AppState, socket: WebSocket, link: ShareLink) {
    let (mut sink, mut stream) = socket.split();
    let Ok(board) = Uuid::parse_str(&link.canvas_id) else {
        tracing::debug!(reason = "unknown board", "socket refused");
        // The client may already be gone; it is refused either way.
        let _ = sink
            .send(close_message(POLICY_VIOLATION, "unknown board"))
            .await;
        return;
    };
    let (tx, rx) = mpsc::channel::<Message>(SEND_QUEUE);
    let too_slow = Arc::new(Notify::new());
    let mut writer = spawn_writer(sink, rx, too_slow.clone());
    let mut writer_done = None;
    let opened = std::time::Instant::now();
    tracing::info!("socket opened");
    let mut from_client = None;
    let id = Uuid::new_v4();
    let mut joined = false;
    let mut recheck = tokio::time::interval(std::time::Duration::from_secs(VIEWER_RECHECK_SECS));
    recheck.tick().await;
    loop {
        tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                let Message::Text(text) = message else {
                    if let Message::Close(frame) = &message {
                        from_client = Some(close_of(frame.as_ref()));
                        break;
                    }
                    continue;
                };
                if joined {
                    continue; // receive-only: nothing a viewer says changes anything
                }
                let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if frame.get("t").and_then(Value::as_str) != Some("hello") {
                    continue;
                }
                // A failed send below means the writer, and so the client, is
                // gone: the loop ends on its own then.
                if frame.get("protocolVersion").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
                    let _ = tx.send(close_message(POLICY_VIOLATION, "protocol version not supported")).await;
                    break;
                }
                let Ok(Some(revision)) = boards::revision(&app.db, &board).await else {
                    let _ = tx.send(close_message(POLICY_VIOLATION, "unknown board")).await;
                    break;
                };
                let _ = tx.send(Message::Text(json!({ "t": "welcome", "actorId": id, "revision": revision, "actors": [] }).to_string().into())).await;
                app.rooms.join_viewer(&board, Viewer { id, share_id: link.id.clone(), tx: tx.clone(), too_slow: too_slow.clone() });
                joined = true;
            }
            _ = recheck.tick() => {
                if !matches!(crate::sharing::active_link(&app.db, &link.id).await, Ok(Some(_))) {
                    // The client may be gone already; it is closed either way.
                    let _ = tx.send(close_message(POLICY_VIOLATION, "this link is no longer active")).await;
                    break;
                }
            }
            // The writer ends when it has sent a close (a revoke) or the client
            // is gone. Leave then, rather than waiting on a client that may
            // never answer the close.
            sent = &mut writer => {
                writer_done = Some(sent.ok().flatten());
                break;
            }
        }
    }
    if joined {
        app.rooms.leave_viewer(&board, id);
    }
    drop(tx);
    let from_server = match writer_done {
        Some(sent) => sent,
        None => writer.await.ok().flatten(),
    };
    log_closed(from_server, from_client, opened);
}

fn close_message(code: u16, reason: &str) -> Message {
    // A close reason may hold at most 123 bytes.
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    Message::Close(Some(CloseFrame {
        code,
        reason: Utf8Bytes::from(&reason[..end]),
    }))
}

struct Connection {
    app: AppState,
    board: Uuid,
    display_name: String,
    actor: Option<Uuid>,
    tx: mpsc::Sender<Message>,
    too_slow: Arc<Notify>,
}

impl Connection {
    async fn handle(&mut self, text: &str) -> Result<(), Close> {
        let frame: Value = serde_json::from_str(text).map_err(|_| invalid("frame is not JSON"))?;
        if !frame.is_object() {
            return Err(invalid("frame is not an object"));
        }
        let t = frame
            .get("t")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("frame has no type"))?;
        let Some(actor) = self.actor else {
            if t != "hello" {
                return Err(invalid(format!("first frame was '{t}', not hello")));
            }
            return self.hello(&frame).await;
        };
        let rooms = &self.app.rooms;
        match t {
            "hello" => return Err(invalid("hello arrived twice")),
            "cursor" => {
                let (x, y) = (finite(&frame, "x")?, finite(&frame, "y")?);
                rooms.with(&self.board, |r| {
                    r.broadcast(
                        Some(actor),
                        &json!({ "t": "cursor", "actorId": actor, "x": x, "y": y }),
                    )
                });
            }
            "selection" => {
                let ids = item_ids(&frame, "itemIds")?;
                rooms.with(&self.board, |r| {
                    r.broadcast(
                        Some(actor),
                        &json!({ "t": "selection", "actorId": actor, "itemIds": ids }),
                    )
                });
            }
            "transform.preview" => {
                let items = previews(&frame)?;
                let expires = now_ms() + LOCK_TTL_MS;
                rooms.with(&self.board, |r| {
                    for (id, _) in &items {
                        if let Some(lock) = r.locks.get_mut(id).filter(|l| l.actor == actor) {
                            lock.expires_at = expires;
                        }
                    }
                    let items: Vec<_> = items
                        .iter()
                        .map(|(id, t)| json!({ "itemId": id, "transform": t }))
                        .collect();
                    r.broadcast(
                        Some(actor),
                        &json!({ "t": "transform.preview", "actorId": actor, "items": items }),
                    );
                });
            }
            "lock.acquire" => {
                let ids = item_ids(&frame, "itemIds")?;
                let now = now_ms();
                let expires_at = now + LOCK_TTL_MS;
                rooms.with(&self.board, |r| {
                    let mut granted = Vec::new();
                    let mut refused = Vec::new();
                    for id in ids {
                        match r.locks.get(&id) {
                            Some(l) if l.expires_at > now && l.actor != actor => refused.push((id, l.actor)),
                            _ => {
                                r.locks.insert(id, Lock { actor, expires_at });
                                granted.push(id);
                            }
                        }
                    }
                    if !granted.is_empty() {
                        let held = json!({ "t": "lock", "itemIds": granted, "heldBy": actor, "expiresAt": expires_at });
                        r.broadcast(None, &held);
                    }
                    for (id, holder) in refused {
                        r.send_to(actor, &json!({ "t": "lock", "itemIds": [id], "heldBy": holder, "expiresAt": expires_at }));
                    }
                });
            }
            "lock.release" => {
                let ids = item_ids(&frame, "itemIds")?;
                rooms.with(&self.board, |r| {
                    let released: Vec<Uuid> = ids
                        .into_iter()
                        .filter(|id| r.locks.get(id).is_some_and(|l| l.actor == actor))
                        .collect();
                    for id in &released {
                        r.locks.remove(id);
                    }
                    if !released.is_empty() {
                        r.broadcast(None, &release_frame(&released));
                    }
                });
            }
            other => tracing::debug!(frame = other, "ignoring an unknown frame type"),
        }
        Ok(())
    }

    async fn hello(&mut self, frame: &Value) -> Result<(), Close> {
        let version = integer(frame, "protocolVersion")?;
        if version != PROTOCOL_VERSION {
            return Err(Close(
                POLICY_VIOLATION,
                format!("protocol version {version} not supported"),
            ));
        }
        integer(frame, "sinceRevision")?;
        let revision = boards::revision(&self.app.db, &self.board)
            .await
            .map_err(|_| Close(SERVER_ERROR, "database unavailable".into()))?
            .ok_or_else(|| Close(POLICY_VIOLATION, "unknown board".into()))?;
        let id = Uuid::new_v4();
        self.app.rooms.with(&self.board, |r| {
            let name = if self.display_name.trim().is_empty() {
                format!("Guest {}", r.actors.len() + 1)
            } else {
                self.display_name.clone()
            };
            let colour = r.free_colour(letter_of(&name));
            r.actors.push(Actor {
                id,
                display_name: name,
                colour,
                tx: self.tx.clone(),
                too_slow: self.too_slow.clone(),
            });
            let actors: Vec<Value> = r
                .actors
                .iter()
                .map(Actor::presence)
                .chain(r.agents.iter().map(AgentPresence::presence))
                .collect();
            r.send_to(
                id,
                &json!({ "t": "welcome", "actorId": id, "revision": revision, "actors": actors }),
            );
            let me = r.actors.last().unwrap().presence();
            r.broadcast(Some(id), &json!({ "t": "presence", "joined": [me] }));
            if !r.viewers.is_empty() {
                r.send_to(id, &r.viewer_count());
            }
        });
        self.actor = Some(id);
        Ok(())
    }
}

fn finite(parent: &Value, field: &str) -> Result<f64, Close> {
    let n = parent
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid(format!("'{field}' is not a number")))?;
    if n.is_finite() {
        Ok(n)
    } else {
        Err(invalid(format!("'{field}' is not finite")))
    }
}

fn integer(parent: &Value, field: &str) -> Result<i64, Close> {
    parent
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(format!("'{field}' is not an integer")))
}

fn item_ids(parent: &Value, field: &str) -> Result<Vec<Uuid>, Close> {
    let list = parent
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("'{field}' is not an array")))?;
    if list.len() > MAX_FRAME_ITEMS {
        return Err(invalid(format!(
            "'{field}' has {} entries, over the {MAX_FRAME_ITEMS} limit",
            list.len()
        )));
    }
    list.iter()
        .map(|v| {
            let s = v
                .as_str()
                .ok_or_else(|| invalid(format!("'{field}' holds a non-string")))?;
            Uuid::parse_str(s)
                .map_err(|_| invalid(format!("'{field}' holds a value that is not a uuid")))
        })
        .collect()
}

fn previews(frame: &Value) -> Result<Vec<(Uuid, Value)>, Close> {
    let items = frame
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("'items' is not an array"))?;
    if items.len() > MAX_FRAME_ITEMS {
        return Err(invalid(format!(
            "'items' has {} entries, over the {MAX_FRAME_ITEMS} limit",
            items.len()
        )));
    }
    items
        .iter()
        .map(|entry| {
            if !entry.is_object() {
                return Err(invalid("'items' holds a non-object"));
            }
            let id = entry
                .get("itemId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("'itemId' is not a string"))?;
            let id = Uuid::parse_str(id).map_err(|_| invalid("'itemId' is not a uuid"))?;
            let t = entry
                .get("transform")
                .filter(|t| t.is_object())
                .ok_or_else(|| invalid("preview has no transform"))?;
            let transform = json!({
                "x": finite(t, "x")?, "y": finite(t, "y")?,
                "width": finite(t, "width")?, "height": finite(t, "height")?,
                "rotation": finite(t, "rotation")?,
            });
            Ok((id, transform))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_follow_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../packages/canvas-core/fixtures/presence-letters.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let (name, letter) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
            assert_eq!(letter_of(name).to_string(), letter, "{name:?}");
        }
    }

    fn agent(name: &str, colour: usize) -> AgentPresence {
        AgentPresence {
            id: Uuid::new_v4(),
            name: name.into(),
            person: "Ada".into(),
            colour,
            last_ms: 0,
        }
    }

    #[test]
    fn colours_are_unique_per_letter_not_per_room() {
        let mut room = Room::default();
        room.agents.push(agent("Ada", 0));
        assert_ne!(room.free_colour('A'), 0, "a second A gets another colour");
        assert_eq!(room.free_colour('R'), 0, "a different letter may share it");
        for slot in 1..COLOUR_SLOTS {
            room.agents.push(agent(&format!("A{slot}"), slot));
        }
        // Every colour is taken for A: the least used, with no panic.
        room.agents.push(agent("Rokas", 0));
        let seventh = room.free_colour('A');
        assert!(seventh < COLOUR_SLOTS);
        assert_ne!(
            seventh, 0,
            "slot 0 is used twice, so it is not the least used"
        );
    }
}
