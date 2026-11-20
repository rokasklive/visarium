//! One board as an agent sees it: its rows read once, refs resolved, titles
//! derived, and what each diagram declares. Every read and write tool starts
//! here, so they all agree on what `d2#Server` means.

use std::collections::HashMap;

use uuid::Uuid;

use crate::agent::diagram::{self, Extracted};
use crate::boards::{Checklist, ITEMS_SQL, ItemRow, LinkRow, links_of, ref_letter};

/// What a tool error says. Tools return it as a readable result, never as a
/// protocol failure (agents/access spec).
pub type Fail = String;

pub struct Group {
    pub id: String,
    pub label: Option<String>,
    pub frame: bool,
    pub ref_no: i64,
    pub collides: bool,
}

impl Group {
    pub fn short_ref(&self) -> String {
        format!("g{}", self.ref_no)
    }
}

pub struct BoardData {
    pub id: Uuid,
    pub title: String,
    pub revision: i64,
    /// `item:<id>` or `group:<id>` (canvas/centerpiece).
    pub centerpiece: Option<String>,
    pub items: Vec<ItemRow>,
    pub groups: Vec<Group>,
    pub links: Vec<LinkRow>,
    /// Account id → display name, for everyone the board credits.
    pub people: HashMap<String, String>,
    /// Asset id → original filename, for image titles.
    pub filenames: HashMap<String, String>,
    structures: HashMap<String, Extracted>,
}

/// Whether a link's element still exists in its diagram.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchored {
    Whole,
    Broken,
    /// The diagram's type has no extractor, so nobody can say.
    Unknown,
}

pub struct Board {
    pub id: Uuid,
    pub title: String,
}

/// A board named by UUID, or by its exact title when that is unique.
pub async fn find_board(db: &sqlx::SqlitePool, named: &str) -> Result<Board, Fail> {
    let named = named.trim();
    if let Ok(id) = Uuid::parse_str(named) {
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM canvas WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(db)
            .await
            .map_err(db_fail)?;
        return title
            .map(|title| Board { id, title })
            .ok_or_else(|| format!("No board has the id {id}. Call desk to list boards."));
    }
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, title, updated_at FROM canvas WHERE lower(title) = lower(?) ORDER BY updated_at DESC")
            .bind(named)
            .fetch_all(db)
            .await
            .map_err(db_fail)?;
    match rows.as_slice() {
        [(id, title, _)] => Ok(Board {
            id: Uuid::parse_str(id).unwrap(),
            title: title.clone(),
        }),
        [] => {
            let all: Vec<String> =
                sqlx::query_scalar("SELECT title FROM canvas ORDER BY updated_at DESC LIMIT 10")
                    .fetch_all(db)
                    .await
                    .map_err(db_fail)?;
            Err(format!(
                "No board is called \"{named}\". Boards: {}. Call desk for the full list.",
                if all.is_empty() {
                    "none yet".into()
                } else {
                    all.iter()
                        .map(|t| format!("\"{t}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ))
        }
        many => Err(format!(
            "{} boards are called \"{named}\"; pass one by id:\n{}",
            many.len(),
            many.iter()
                .map(|(id, t, at)| format!("- \"{t}\" {id} (last change {})", short_time(at)))
                .collect::<Vec<_>>()
                .join("\n")
        )),
    }
}

pub fn db_fail(e: sqlx::Error) -> Fail {
    format!("The database could not answer ({e}). Try again.")
}

/// `2026-11-19T14:03:07.120Z` → `2026-11-19 14:03 UTC`.
pub fn short_time(iso: &str) -> String {
    if iso.len() >= 16 {
        format!("{} {} UTC", &iso[..10], &iso[11..16])
    } else {
        iso.to_string()
    }
}

impl BoardData {
    pub async fn load(db: &sqlx::SqlitePool, board: &Board) -> Result<BoardData, Fail> {
        let id = board.id.to_string();
        let mut tx = db.begin().await.map_err(db_fail)?;
        let (title, revision, centerpiece): (String, i64, Option<String>) =
            sqlx::query_as("SELECT title, revision, centerpiece FROM canvas WHERE id = ?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_fail)?
                .ok_or_else(|| format!("Board \"{}\" no longer exists.", board.title))?;
        let items: Vec<ItemRow> = sqlx::query_as(ITEMS_SQL)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_fail)?;
        let groups: Vec<(String, Option<String>, bool, i64, bool)> = sqlx::query_as(
            "SELECT id, label, frame, ref_no, collides FROM canvas_group WHERE canvas_id = ? ORDER BY ref_no",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_fail)?;
        let links = links_of(&mut tx, &id).await.map_err(db_fail)?;
        let people: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, display_name FROM app_user WHERE id IN (
                SELECT created_by FROM canvas_link WHERE canvas_id = ?1
                UNION SELECT actor_id FROM canvas_operation WHERE canvas_id = ?1
                UNION SELECT json_extract(t.value, '$.by') FROM canvas_item i, json_each(i.body, '$.tasks') t
                 WHERE i.canvas_id = ?1 AND i.kind = 'checklist')",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_fail)?;
        let filenames: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT a.id, a.original_filename FROM asset a WHERE a.id IN (SELECT asset_id FROM canvas_item WHERE canvas_id = ?)",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_fail)?;
        tx.commit().await.map_err(db_fail)?;
        let structures = items
            .iter()
            .filter(|i| i.kind == "diagram")
            .map(|i| {
                (
                    i.id.clone(),
                    diagram::extract(
                        i.lang.as_deref().unwrap_or("mermaid"),
                        i.body.as_deref().unwrap_or(""),
                    ),
                )
            })
            .collect();
        Ok(BoardData {
            id: board.id,
            title,
            revision,
            centerpiece,
            items,
            groups: groups
                .into_iter()
                .map(|(id, label, frame, ref_no, collides)| Group {
                    id,
                    label,
                    frame,
                    ref_no,
                    collides,
                })
                .collect(),
            links,
            people: people.into_iter().collect(),
            filenames: filenames
                .into_iter()
                .filter_map(|(id, f)| f.map(|f| (id, f)))
                .collect(),
            structures,
        })
    }

    /// Whether the board pushes this item aside: its group's setting, or its
    /// own when it has none (canvas/collision).
    pub fn collides(&self, i: &ItemRow) -> bool {
        match i.group_id.as_deref().and_then(|g| self.groups.iter().find(|x| x.id == g)) {
            Some(g) => g.collides,
            None => i.collides,
        }
    }

    pub fn item(&self, id: &str) -> Option<&ItemRow> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn group(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }

    pub fn structure(&self, item: &ItemRow) -> Option<&Extracted> {
        self.structures.get(&item.id)
    }

    pub fn ref_of(&self, item_id: &str) -> String {
        self.item(item_id)
            .map_or_else(|| "(deleted item)".into(), ItemRow::short_ref)
    }

    pub fn person(&self, id: Option<&str>) -> String {
        id.and_then(|id| self.people.get(id))
            .cloned()
            .unwrap_or_else(|| "someone".into())
    }

    /// "Ana", or "Claude Code for Ana" when an agent acted.
    pub fn credit(&self, by: Option<&str>, agent: Option<&str>) -> String {
        match agent {
            Some(a) => format!("{a} for {}", self.person(by)),
            None => self.person(by),
        }
    }

    /// An item by ref (`d2`) or UUID. The error names the refs that exist.
    pub fn resolve_item(&self, r: &str) -> Result<&ItemRow, Fail> {
        // `c1/t5` names a task: its item is `c1`.
        let r = r.trim().split('/').next().unwrap_or("").trim();
        if let Ok(id) = Uuid::parse_str(r) {
            return self
                .item(&id.to_string())
                .ok_or_else(|| format!("No item {id} on \"{}\".", self.title));
        }
        let letter = r
            .chars()
            .next()
            .map(|c| c.to_ascii_lowercase().to_string())
            .unwrap_or_default();
        let number: Option<i64> = r.get(1..).and_then(|n| n.parse().ok());
        if let Some(n) = number
            && let Some(item) = self
                .items
                .iter()
                .find(|i| ref_letter(&i.kind) == letter && i.ref_no == n)
        {
            return Ok(item);
        }
        let mut same: Vec<String> = self
            .items
            .iter()
            .filter(|i| ref_letter(&i.kind) == letter)
            .map(ItemRow::short_ref)
            .collect();
        same.sort_by_key(|s| s[1..].parse::<i64>().unwrap_or(0));
        let kind = match letter.as_str() {
            "n" => "notes",
            "d" => "diagrams",
            "c" => "checklists",
            "i" => "images",
            _ => {
                return Err(format!(
                    "'{r}' is not a ref. Refs are a kind letter and a number: n (note), d (diagram), c (checklist), i (image), g (group); for example d2."
                ));
            }
        };
        Err(if same.is_empty() {
            format!(
                "'{r}' does not exist on \"{}\", which has no {kind}.",
                self.title
            )
        } else {
            format!(
                "'{r}' does not exist on \"{}\". Its {kind}: {}.",
                self.title,
                same.join(", ")
            )
        })
    }

    /// The centerpiece's short ref, `g1` or `d2`, when it is still on the board.
    pub fn centerpiece_ref(&self) -> Option<String> {
        let (kind, id) = self.centerpiece.as_deref()?.split_once(':')?;
        match kind {
            "group" => self.group(id).map(Group::short_ref),
            _ => self.items.iter().find(|i| i.id == id).map(ItemRow::short_ref),
        }
    }

    pub fn resolve_group(&self, r: &str) -> Result<&Group, Fail> {
        let r = r.trim();
        if let Ok(id) = Uuid::parse_str(r) {
            return self
                .group(&id.to_string())
                .ok_or_else(|| format!("No group {id} on this board."));
        }
        let n: Option<i64> = r
            .strip_prefix('g')
            .or_else(|| r.strip_prefix('G'))
            .and_then(|n| n.parse().ok());
        n.and_then(|n| self.groups.iter().find(|g| g.ref_no == n))
            .ok_or_else(|| {
                let all: Vec<String> = self
                    .groups
                    .iter()
                    .map(|g| format!("{} \"{}\"", g.short_ref(), g.label.as_deref().unwrap_or("")))
                    .collect();
                if all.is_empty() {
                    format!("'{r}' does not exist: this board has no groups or frames.")
                } else {
                    format!("'{r}' does not exist. Groups: {}.", all.join(", "))
                }
            })
    }

    /// `d2#Server` or `d2`: an item and maybe an element. With `validate`, an
    /// element must be declared by the diagram's source when its type is
    /// extracted (canvas/diagram-structure).
    pub fn resolve_anchor(
        &self,
        r: &str,
        validate: bool,
    ) -> Result<(&ItemRow, Option<String>), Fail> {
        let (item_ref, element) = match r.split_once('#') {
            Some((i, e)) => (i, Some(e.trim().to_string())),
            None => (r, None),
        };
        let item = self.resolve_item(item_ref)?;
        let Some(element) = element.filter(|e| !e.is_empty()) else {
            return Ok((item, None));
        };
        if item.kind == "note" {
            // A passage (canvas/text-anchors): a `^id` or a heading's slug the
            // note has. Never by position, so an agent names one first.
            let names = crate::agent::blocks::block_names(item.body.as_deref().unwrap_or(""));
            if validate && !names.contains(&element) {
                return Err(format!(
                    "{} has no passage '{element}'. Its passages: {}. To point at a paragraph, end it with ` ^name` (item_edit), then link {}#^name.",
                    item.short_ref(),
                    if names.is_empty() { "none".into() } else { names.join(", ") },
                    item.short_ref()
                ));
            }
            return Ok((item, Some(element)));
        }
        if item.kind != "diagram" {
            return Err(format!(
                "{} is a {}; only a diagram's elements and a note's passages can be pointed at with #.",
                item.short_ref(),
                item.kind
            ));
        }
        if validate
            && let Some(Extracted::Known(s)) = self.structure(item)
            && !s.elements.iter().any(|e| e == &element)
        {
            return Err(format!(
                "{} declares no element '{element}'. Its elements: {}.",
                item.short_ref(),
                if s.elements.is_empty() {
                    "none".into()
                } else {
                    s.elements.join(", ")
                }
            ));
        }
        Ok((item, Some(element)))
    }

    /// A checklist task, `c1/t3`, or `t3` in a checklist already known.
    pub fn checklist(&self, item: &ItemRow) -> Result<Checklist, Fail> {
        if item.kind != "checklist" {
            return Err(format!(
                "{} is a {}, not a checklist.",
                item.short_ref(),
                item.kind
            ));
        }
        serde_json::from_str(item.body.as_deref().unwrap_or("{}"))
            .map_err(|_| format!("{} is stored unreadably.", item.short_ref()))
    }

    pub fn anchored(&self, item_id: &str, element: Option<&str>) -> Anchored {
        let Some(element) = element else {
            return Anchored::Whole;
        };
        if let Some(note) = self.item(item_id).filter(|i| i.kind == "note") {
            let names = crate::agent::blocks::block_names(note.body.as_deref().unwrap_or(""));
            return if names.iter().any(|n| n == element) { Anchored::Whole } else { Anchored::Broken };
        }
        match self.item(item_id).and_then(|i| self.structure(i)) {
            Some(Extracted::Known(s)) if s.elements.iter().any(|e| e == element) => Anchored::Whole,
            Some(Extracted::Known(_)) => Anchored::Broken,
            _ => Anchored::Unknown,
        }
    }

    /// Links whose element anchor its diagram no longer declares. Links into
    /// a diagram type without an extractor are unknown, never broken.
    pub fn broken_links(&self) -> Vec<&LinkRow> {
        self.links
            .iter()
            .filter(|l| {
                self.anchored(&l.from_item, l.from_element.as_deref()) == Anchored::Broken
                    || self.anchored(&l.to_item, l.to_element.as_deref()) == Anchored::Broken
            })
            .collect()
    }

    /// `d1#OpQueue`, or `d1` for a whole item.
    pub fn anchor_text(&self, item_id: &str, element: Option<&str>) -> String {
        match element {
            Some(e) => format!("{}#{e}", self.ref_of(item_id)),
            None => self.ref_of(item_id),
        }
    }

    /// A short title: a note's first heading or line, a diagram's `title`,
    /// a checklist's title, an image's filename.
    pub fn title_of(&self, item: &ItemRow) -> String {
        let clip = |s: &str| {
            let s = s.trim();
            if s.chars().count() > 60 {
                format!("{}…", s.chars().take(59).collect::<String>())
            } else {
                s.to_string()
            }
        };
        match item.kind.as_str() {
            "note" => {
                let body = item.body.as_deref().unwrap_or("");
                let line = body
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .unwrap_or("(empty)");
                clip(line.trim_start_matches('#').trim())
            }
            "diagram" => match self.structure(item) {
                Some(Extracted::Known(s)) if s.title.is_some() => clip(s.title.as_deref().unwrap()),
                _ => String::new(),
            },
            "checklist" => clip(&self.checklist(item).map(|c| c.title).unwrap_or_default()),
            "image" => item
                .asset_id
                .as_ref()
                .and_then(|a| self.filenames.get(a))
                .map_or_else(|| "image".into(), |f| clip(f)),
            other => other.to_string(),
        }
    }

    /// What kind of thing an item is, in a few words: `plantuml sequence`.
    pub fn kind_of(&self, item: &ItemRow) -> String {
        match item.kind.as_str() {
            "diagram" => {
                let lang = item.lang.as_deref().unwrap_or("mermaid");
                match self.structure(item) {
                    Some(Extracted::Known(s)) => format!("{lang} {}", s.kind),
                    Some(Extracted::Unsupported(t)) => t.clone(),
                    None => lang.to_string(),
                }
            }
            k => k.to_string(),
        }
    }
}
