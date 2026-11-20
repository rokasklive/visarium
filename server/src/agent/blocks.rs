//! A note's passages as link anchors (canvas/text-anchors): paragraphs and list
//! items named by a trailing ` ^id`, headings by their slug. The browser's
//! `objects/blocks.ts` reads the same names the same way; the fixture test in
//! both keeps them in step.

/// The names a note's passages have, in reading order. The note's opening
/// heading is its title and names the whole note, so it is not a passage.
pub fn block_names(source: &str) -> Vec<String> {
    let mut names = vec![];
    let mut slugs: std::collections::HashMap<String, usize> = Default::default();
    let mut fenced = false;
    let mut open = false;
    let mut last_line = String::new();
    let mut first = true;
    let flush = |open: &mut bool, last_line: &str, names: &mut Vec<String>| {
        if *open && let Some(m) = marker(last_line) {
            names.push(format!("^{m}"));
        }
        *open = false;
    };
    for raw in source.lines() {
        let fence = raw.trim_start();
        if fence.starts_with("```") || fence.starts_with("~~~") {
            flush(&mut open, &last_line, &mut names);
            fenced = !fenced;
            first = false;
            continue;
        }
        if fenced {
            continue;
        }
        let line = strip_quote(raw);
        if line.trim().is_empty() {
            flush(&mut open, &last_line, &mut names);
            continue;
        }
        if let Some(text) = heading(line) {
            flush(&mut open, &last_line, &mut names);
            let title = first;
            first = false;
            if let Some(m) = marker(text) {
                if !title {
                    names.push(format!("^{m}"));
                }
                continue;
            }
            let base = slug(text);
            let seen = slugs.entry(base.clone()).or_insert(0);
            let name = if *seen > 0 {
                format!("{base}-{seen}")
            } else {
                base
            };
            *seen += 1;
            if !title && !name.is_empty() {
                names.push(name);
            }
            continue;
        }
        first = false;
        if is_item(line) {
            flush(&mut open, &last_line, &mut names);
        }
        open = true;
        last_line = line.to_string();
    }
    flush(&mut open, &last_line, &mut names);
    names
}

/// A heading's slug: lowercase, punctuation dropped, spaces to dashes.
pub fn slug(text: &str) -> String {
    let kept: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join("-")
}

/// ` ^id` at the end of a line.
fn marker(line: &str) -> Option<&str> {
    let t = line.trim_end();
    let at = t.rfind('^')?;
    let id = &t[at + 1..];
    let before = t[..at].chars().last();
    (!id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && matches!(before, Some(' ' | '\t')))
    .then_some(id)
}

/// An ATX heading's text, without its `#`s.
fn heading(line: &str) -> Option<&str> {
    let t = line
        .strip_prefix("   ")
        .or_else(|| line.strip_prefix("  "))
        .or_else(|| line.strip_prefix(' '))
        .unwrap_or(line);
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &t[hashes..];
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some(rest.trim().trim_end_matches('#').trim_end())
}

fn is_item(line: &str) -> bool {
    let t = line.trim_start();
    let bullet = t.starts_with(['-', '*', '+']) && t[1..].starts_with([' ', '\t']);
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    let numbered = digits > 0
        && t[digits..].starts_with(['.', ')'])
        && t[digits + 1..].starts_with([' ', '\t']);
    bullet || numbered
}

fn strip_quote(line: &str) -> &str {
    let t = line.trim_start();
    match t.strip_prefix('>') {
        Some(rest) => rest.strip_prefix(' ').unwrap_or(rest),
        None => line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_passages_as_the_browser_does() {
        let note = "## Title\n\nThe adapter retries twice. ^retry\n\nThen it gives up,\nand says why.\n\n- First item ^one\n- Second item\n  continues here\n\n```\nNot a block ^nope\n```\n\n## Bounds and fallbacks\n\n## Bounds and fallbacks";
        assert_eq!(
            block_names(note),
            vec![
                "^retry",
                "^one",
                "bounds-and-fallbacks",
                "bounds-and-fallbacks-1"
            ]
        );
        assert_eq!(slug("Bounds, and *fallbacks*!"), "bounds-and-fallbacks");
        assert!(
            block_names("Price is 2^10").is_empty(),
            "a caret mid-word is not a marker"
        );
    }
}
