//! Item views (canvas/item-views, ADR-0034): a few read-only representations
//! of each item, derived from its source at one revision, so apps and agents
//! can take an item as data without copying it. Nothing is stored: a view is
//! a pure function of the item, so the same revision always gives the same
//! view.
// ponytail: no cache. Deriving is a parse of one item; add an (item, rev,
// view) LRU when app inputs re-resolve often enough to show up in profiles.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::{Map, Value, json};

use crate::agent::board::{BoardData, Group};
use crate::agent::status;
use crate::boards::ItemRow;

/// What can be viewed: one item, or a group (by its members).
pub enum Target<'a> {
    Item(&'a ItemRow),
    Group(&'a Group),
}

impl Target<'_> {
    pub fn kind(&self) -> &str {
        match self {
            Target::Item(i) => &i.kind,
            Target::Group(_) => "group",
        }
    }
    pub fn short_ref(&self) -> String {
        match self {
            Target::Item(i) => i.short_ref(),
            Target::Group(g) => g.short_ref(),
        }
    }
}

/// The views a kind offers, in the order a picker shows them.
pub fn offered(kind: &str) -> &'static [&'static str] {
    match kind {
        "note" => &["text", "markdown", "frontmatter", "tables"],
        "diagram" => &["text", "graph"],
        "checklist" => &["text", "tasks"],
        "image" => &["text", "asset"],
        "app" => &["text", "outputs"],
        "group" => &["members"],
        _ => &[],
    }
}

/// `g2`, a group's UUID, or anything `resolve_item` takes.
pub fn resolve<'a>(b: &'a BoardData, r: &str) -> Result<Target<'a>, String> {
    let r = r.trim();
    let is_group_ref =
        r.len() > 1 && r.starts_with(['g', 'G']) && r[1..].chars().all(|c| c.is_ascii_digit());
    if is_group_ref {
        return b.resolve_group(r).map(Target::Group);
    }
    match b.resolve_item(r) {
        Ok(i) => Ok(Target::Item(i)),
        Err(e) => match uuid::Uuid::parse_str(r) {
            Ok(_) => b.resolve_group(r).map(Target::Group).map_err(|_| e),
            Err(_) => Err(e),
        },
    }
}

/// One view of a target, stamped with what it was derived from:
/// `{ ref, kind, revision, view, value, warning? }`. A group has no revision
/// of its own, so it carries the board's.
pub fn view(b: &BoardData, t: &Target, name: &str) -> Result<Value, String> {
    let offers = offered(t.kind());
    if !offers.contains(&name) {
        return Err(if offers.is_empty() {
            format!(
                "{} is a {}, which offers no views.",
                t.short_ref(),
                t.kind()
            )
        } else {
            format!(
                "{} is a {}; it has no '{name}' view. Its views: {}.",
                t.short_ref(),
                t.kind(),
                offers.join(", ")
            )
        });
    }
    let (value, warning) = match t {
        Target::Item(i) => item_view(b, i, name),
        Target::Group(g) => (members(b, g), None),
    };
    let revision = match t {
        // What the item shows, not where it is: a move changes no view.
        Target::Item(i) => i.content_rev,
        Target::Group(_) => b.revision,
    };
    let mut out = json!({
        "ref": t.short_ref(),
        "kind": t.kind(),
        "revision": revision,
        "view": name,
        "value": value,
    });
    if let Some(w) = warning {
        out["warning"] = Value::String(w);
    }
    Ok(out)
}

/// `GET /api/boards/{id}/items/{item}/views/{view}`: one view, for the
/// browser resolving an app's inputs. `{item}` is an item's or a group's id.
pub async fn get_view(
    axum::extract::State(app): axum::extract::State<crate::AppState>,
    axum::extract::Path((board, item, name)): axum::extract::Path<(uuid::Uuid, uuid::Uuid, String)>,
) -> crate::error::ApiResult<axum::Json<Value>> {
    use crate::error::ApiError;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM canvas WHERE id = ?")
        .bind(board.to_string())
        .fetch_optional(&app.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found(format!("no board {board}")));
    }
    let b = BoardData::load(
        &app.db,
        &crate::agent::board::Board {
            id: board,
            title: String::new(),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let target = resolve(&b, &item.to_string()).map_err(ApiError::not_found)?;
    view(&b, &target, &name)
        .map(axum::Json)
        .map_err(ApiError::bad_request)
}

/// A view the kind offers (checked by the caller), with a warning when the
/// source could not be fully understood.
fn item_view(b: &BoardData, i: &ItemRow, name: &str) -> (Value, Option<String>) {
    let source = i.body.as_deref().unwrap_or("");
    match (i.kind.as_str(), name) {
        ("note", "text") => (Value::String(plain_text(status::body(source))), None),
        ("note", "markdown") => (Value::String(source.to_string()), None),
        ("note", "frontmatter") => frontmatter(source),
        ("note", "tables") => (tables(status::body(source)), None),
        ("diagram", "text") => (Value::String(source.to_string()), None),
        ("diagram", "graph") => match b.structure(i) {
            Some(e) => match e.structure() {
                Some(s) => (
                    json!({ "type": e.type_name(), "title": s.title, "elements": s.elements, "edges": s.edges }),
                    s.warning
                        .as_ref()
                        .map(|(line, why)| format!("line {line}: {why}")),
                ),
                None => (
                    json!({ "type": e.type_name(), "elements": [], "edges": [] }),
                    Some(format!(
                        "{} diagrams have no extracted elements.",
                        e.type_name()
                    )),
                ),
            },
            None => (json!({ "elements": [], "edges": [] }), None),
        },
        ("checklist", _) => match b.checklist(i) {
            Ok(c) if name == "tasks" => (
                json!({
                    "title": c.title,
                    "tasks": c.tasks.iter().map(|t| json!({ "id": t.id, "text": t.text, "state": t.state })).collect::<Vec<_>>(),
                }),
                None,
            ),
            Ok(c) => {
                let mut text = c.title.clone();
                for t in &c.tasks {
                    let mark = if t.state == "done" { "x" } else { " " };
                    text.push_str(&format!("\n- [{mark}] {}", t.text));
                }
                (Value::String(text), None)
            }
            Err(e) => (Value::Null, Some(e)),
        },
        ("image", "text") => {
            let text = b
                .description_of(i)
                .map(|d| {
                    [&d.caption, &d.description, &d.visible_text]
                        .into_iter()
                        .flatten()
                        .filter(|s| !s.is_empty())
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            (Value::String(text), None)
        }
        ("image", "asset") => match &i.asset_id {
            Some(a) => (
                json!({
                    "mime": i.mime_type,
                    "width": i.intrinsic_width,
                    "height": i.intrinsic_height,
                    "url": format!("/api/assets/{a}/content"),
                }),
                None,
            ),
            None => (
                Value::Null,
                Some("The image has not finished uploading.".into()),
            ),
        },
        ("app", "outputs") => match b.outputs.get(&i.id) {
            Some(o) => (serde_json::from_str(&o.outputs).unwrap_or(json!({})), None),
            None => (json!({}), Some("This app has never run.".into())),
        },
        ("app", "text") => {
            let title = serde_json::from_str::<crate::apps::AppBody>(source)
                .map(|a| a.title)
                .unwrap_or_default();
            let text = b
                .outputs
                .get(&i.id)
                .and_then(|o| o.text.clone())
                .unwrap_or_default();
            (
                Value::String(format!("{title}\n{text}").trim().to_string()),
                None,
            )
        }
        _ => (Value::Null, None),
    }
}

fn members(b: &BoardData, g: &Group) -> Value {
    let list: Vec<Value> = b
        .items
        .iter()
        .filter(|i| i.group_id.as_deref() == Some(g.id.as_str()))
        .map(|i| {
            let text = if offered(&i.kind).contains(&"text") {
                item_view(b, i, "text").0
            } else {
                Value::Null
            };
            json!({ "ref": i.short_ref(), "kind": i.kind, "text": text })
        })
        .collect();
    json!({ "label": g.label, "members": list })
}

const MARKDOWN: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS);

/// What a reader sees: Markdown without its syntax, one line per block.
fn plain_text(markdown: &str) -> String {
    let mut out = String::new();
    for event in Parser::new_ext(markdown, MARKDOWN) {
        match event {
            Event::Text(t) | Event::Code(t) | Event::InlineMath(t) | Event::DisplayMath(t) => {
                out.push_str(&t)
            }
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::End(TagEnd::TableCell) => out.push('\t'),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::TableHead
                | TagEnd::TableRow
                | TagEnd::CodeBlock,
            ) => {
                if out.ends_with('\t') {
                    out.pop();
                }
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    out.trim_end().to_string()
}

/// The frontmatter as an object: `{}` when there is none, and `{}` with a
/// warning when it is not a YAML mapping.
fn frontmatter(source: &str) -> (Value, Option<String>) {
    let Some(text) = status::frontmatter(source) else {
        return (json!({}), None);
    };
    match serde_yaml_ng::from_str::<Value>(&text) {
        Ok(v @ Value::Object(_)) => (v, None),
        Ok(Value::Null) => (json!({}), None),
        Ok(_) => (
            json!({}),
            Some("The frontmatter is not a mapping of keys to values.".into()),
        ),
        Err(e) => (
            json!({}),
            Some(format!("The frontmatter is not valid YAML: {e}")),
        ),
    }
}

/// Every table in source order: `{ headers, rows }`, each row keyed by the
/// headers as written. An empty header becomes `column_N`, a repeated one
/// `name_2`; a missing cell is "".
fn tables(markdown: &str) -> Value {
    let mut tables: Vec<Value> = Vec::new();
    let mut headers: Vec<String> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<String> = None;
    for event in Parser::new_ext(markdown, MARKDOWN) {
        match event {
            Event::Start(Tag::Table(_)) => {
                headers.clear();
                rows.clear();
            }
            Event::Start(Tag::TableHead | Tag::TableRow) => row.clear(),
            Event::Start(Tag::TableCell) => cell = Some(String::new()),
            Event::Text(t) | Event::Code(t) => {
                if let Some(c) = cell.as_mut() {
                    c.push_str(&t);
                }
            }
            Event::End(TagEnd::TableCell) => {
                row.push(cell.take().unwrap_or_default().trim().into())
            }
            Event::End(TagEnd::TableHead) => headers = unique_headers(&row),
            Event::End(TagEnd::TableRow) => {
                let mut r = Map::new();
                for (n, h) in headers.iter().enumerate() {
                    r.insert(
                        h.clone(),
                        Value::String(row.get(n).cloned().unwrap_or_default()),
                    );
                }
                rows.push(Value::Object(r));
            }
            Event::End(TagEnd::Table) => tables.push(json!({
                "headers": headers,
                "rows": std::mem::take(&mut rows),
            })),
            _ => {}
        }
    }
    Value::Array(tables)
}

fn unique_headers(cells: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (n, c) in cells.iter().enumerate() {
        let base = if c.is_empty() {
            format!("column_{}", n + 1)
        } else {
            c.clone()
        };
        let mut name = base.clone();
        let mut k = 2;
        while out.contains(&name) {
            name = format!("{base}_{k}");
            k += 1;
        }
        out.push(name);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_is_an_object() {
        let (v, w) = frontmatter("---\nage: 34\ncarValue: 18000\n---\n# Policy");
        assert_eq!(v, json!({ "age": 34, "carValue": 18000 }));
        assert!(w.is_none());
    }

    #[test]
    fn missing_frontmatter_is_empty_without_warning() {
        assert_eq!(frontmatter("# Policy\nage: 34"), (json!({}), None));
    }

    #[test]
    fn broken_frontmatter_is_empty_with_a_warning() {
        let (v, w) = frontmatter("---\nage: [34\n---\n# Policy");
        assert_eq!(v, json!({}));
        assert!(w.unwrap().contains("not valid YAML"));
        let (v, w) = frontmatter("---\n- just\n- a list\n---\n");
        assert_eq!(v, json!({}));
        assert!(w.unwrap().contains("not a mapping"));
    }

    #[test]
    fn a_table_is_rows_keyed_by_headers() {
        let md = "# Cases\n\n| Case | Premium |\n|---|---|\n| young | 1240 |\n| old | `980` |\n";
        assert_eq!(
            tables(md),
            json!([{ "headers": ["Case", "Premium"], "rows": [
                { "Case": "young", "Premium": "1240" },
                { "Case": "old", "Premium": "980" },
            ]}])
        );
    }

    #[test]
    fn odd_headers_are_named_and_short_rows_padded() {
        let md = "| A | A |  |\n|---|---|---|\n| 1 |\n";
        assert_eq!(
            tables(md),
            json!([{ "headers": ["A", "A_2", "column_3"], "rows": [{ "A": "1", "A_2": "", "column_3": "" }] }])
        );
    }

    #[test]
    fn several_tables_in_order_and_none_when_absent() {
        let md = "| x |\n|---|\n| 1 |\n\ntext\n\n| y |\n|---|\n| 2 |\n";
        let t = tables(md);
        assert_eq!(t[0]["headers"], json!(["x"]));
        assert_eq!(t[1]["headers"], json!(["y"]));
        assert_eq!(tables("no tables here"), json!([]));
    }

    #[test]
    fn plain_text_drops_syntax_and_keeps_blocks() {
        let md = "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        assert_eq!(
            plain_text(md),
            "Title\nSome bold and code.\none\ntwo\na\tb\n1\t2"
        );
    }

    #[test]
    fn each_kind_offers_its_views() {
        assert_eq!(
            offered("note"),
            ["text", "markdown", "frontmatter", "tables"]
        );
        assert_eq!(offered("diagram"), ["text", "graph"]);
        assert_eq!(offered("checklist"), ["text", "tasks"]);
        assert_eq!(offered("image"), ["text", "asset"]);
        assert_eq!(offered("group"), ["members"]);
    }
}
