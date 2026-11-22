//! A note's status (canvas/note-status): a decision or a question, and where
//! it stands, read from the note's own source on every read. Nothing is
//! stored. The browser's `objects/status.ts` reads it the same way; the shared
//! fixture `note-status.json` keeps the two in step.

/// Frontmatter counts only when its closing `---` is within this many lines.
const FRONTMATTER_LINES: usize = 20;
/// A `Status:` line counts among this many non-empty lines after the title.
const STATUS_LINES: usize = 3;

const DECISION: [&str; 5] = [
    "proposed",
    "accepted",
    "rejected",
    "deprecated",
    "superseded",
];
const QUESTION: [&str; 2] = ["open", "answered"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    /// `decision`, `question`, or `none` for a word the board does not know.
    pub kind: &'static str,
    pub state: Option<&'static str>,
    /// The value as written, bold markers dropped.
    pub raw: String,
}

impl Status {
    pub fn is(&self, kind: &str, state: &str) -> bool {
        self.kind == kind && self.state == Some(state)
    }

    /// `decision · accepted`, or the raw word when it is not known.
    pub fn label(&self) -> String {
        match self.state {
            Some(s) => format!("{} · {s}", self.kind),
            None => self.raw.clone(),
        }
    }
}

/// The line index of frontmatter's closing `---`, when the source opens with
/// frontmatter that closes in time.
fn frontmatter_end(lines: &[&str]) -> Option<usize> {
    if lines.first()?.trim_end() != "---" {
        return None;
    }
    (1..lines.len().min(FRONTMATTER_LINES + 1)).find(|&n| lines[n].trim_end() == "---")
}

/// The source after any frontmatter: what renders, and where the title is.
pub fn body(source: &str) -> &str {
    let lines: Vec<&str> = source.split('\n').collect();
    match frontmatter_end(&lines) {
        Some(end) => {
            let skip: usize = lines[..=end].iter().map(|l| l.len() + 1).sum();
            source.get(skip..).unwrap_or("")
        }
        None => source,
    }
}

pub fn status_of(source: &str) -> Option<Status> {
    let lines: Vec<&str> = source.lines().collect();
    if let Some(end) = frontmatter_end(&lines) {
        for line in &lines[1..end] {
            if let Some((key, value)) = line.split_once(':')
                && key.trim().eq_ignore_ascii_case("status")
            {
                let value = value.trim().trim_matches(['"', '\'']).trim();
                return matched(value);
            }
        }
    }
    let mut near = body(source)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let mut first = near.next()?;
    if crate::agent::blocks::heading(first).is_some() {
        first = near.next()?;
    }
    std::iter::once(first)
        .chain(near)
        .take(STATUS_LINES)
        .find_map(status_line)
        .and_then(|v| matched(&v))
}

/// The value of `Status: X`, `**Status:** X` or `**Status: X**`.
fn status_line(line: &str) -> Option<String> {
    let plain = line.replace('*', "");
    let plain = plain.trim();
    let key = plain.get(..7)?;
    (key.starts_with('S') && key.eq_ignore_ascii_case("status:"))
        .then(|| plain[7..].trim().to_string())
}

fn matched(raw: &str) -> Option<Status> {
    let raw = raw.replace('*', "").trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_lowercase();
    let word = lower
        .split(|c: char| !c.is_alphanumeric())
        .find(|w| !w.is_empty())
        .unwrap_or("");
    // "open question" and "open" are both an open question.
    let (kind, state) = if let Some(s) = DECISION.iter().find(|s| **s == word) {
        ("decision", Some(*s))
    } else if let Some(s) = QUESTION.iter().find(|s| **s == word) {
        ("question", Some(*s))
    } else {
        ("none", None)
    };
    Some(Status { kind, state, raw })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn status_follows_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/canvas-core/fixtures/note-status.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let got = status_of(case["source"].as_str().unwrap())
                .map(|s| serde_json::json!({ "kind": s.kind, "state": s.state, "raw": s.raw }));
            let want = case["expect"].clone();
            assert_eq!(
                got.unwrap_or(Value::Null),
                want,
                "{}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn body_skips_frontmatter() {
        assert_eq!(body("---\nstatus: open\n---\n# Q\nText"), "# Q\nText");
        assert_eq!(body("# Q\nText"), "# Q\nText");
    }
}
