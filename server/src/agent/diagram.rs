//! What a diagram declares, read from its source: element names and the edges
//! between them (ADR-0031). Not a grammar: declared names, arrows and labels,
//! for the six diagram types the board can anchor links in. Layout, styling
//! and semantics are the renderer's.
//!
//! Names must equal what the browser reads from the rendered SVG
//! (`elementsOf` in web/src/features/canvas/objects/layout.ts): a Mermaid
//! node, class or participant id; a PlantUML participant, class or component
//! code. `packages/canvas-core/fixtures/diagrams/` is checked by both sides.

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Structure {
    /// `flowchart`, `sequence`, `class` or `component`.
    pub kind: &'static str,
    pub title: Option<String>,
    pub elements: Vec<String>,
    pub edges: Vec<Edge>,
    /// The first line that does not read as the diagram type: (1-based line, why).
    #[serde(skip)]
    pub warning: Option<(usize, String)>,
}

#[derive(Debug)]
pub enum Extracted {
    Known(Structure),
    /// A type whose elements are not extracted: `gantt`, `mindmap`, …
    Unsupported(String),
}

impl Extracted {
    pub fn structure(&self) -> Option<&Structure> {
        match self {
            Extracted::Known(s) => Some(s),
            Extracted::Unsupported(_) => None,
        }
    }
    /// `plantuml sequence`, `mermaid gantt`: what kind of diagram this is.
    pub fn type_name(&self) -> String {
        match self {
            Extracted::Known(s) => s.kind.to_string(),
            Extracted::Unsupported(t) => t.clone(),
        }
    }
}

pub fn extract(lang: &str, source: &str) -> Extracted {
    match lang {
        "plantuml" => plantuml(source),
        _ => mermaid(source),
    }
}

impl Structure {
    fn new(kind: &'static str) -> Self {
        Structure {
            kind,
            ..Default::default()
        }
    }
    fn element(&mut self, name: &str) {
        let name = name.trim();
        if !name.is_empty() && !self.elements.iter().any(|e| e == name) {
            self.elements.push(name.to_string());
        }
    }
    /// A name as written, resolved the way PlantUML does: `API` written
    /// outside its package is `Backend.API` when that is the only match.
    fn resolve(&self, name: &str) -> String {
        let name = name.trim();
        if self.elements.iter().any(|e| e == name) {
            return name.to_string();
        }
        let suffix = format!(".{name}");
        let mut matches = self.elements.iter().filter(|e| e.ends_with(&suffix));
        match (matches.next(), matches.next()) {
            (Some(one), None) => one.clone(),
            _ => name.to_string(),
        }
    }
    fn edge(&mut self, from: &str, to: &str, label: Option<&str>) {
        let (from, to) = (self.resolve(from), self.resolve(to));
        self.element(&from);
        self.element(&to);
        let label = label
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from);
        self.edges.push(Edge { from, to, label });
    }
    fn warn(&mut self, line: usize, why: impl Into<String>) {
        if self.warning.is_none() {
            self.warning = Some((line, why.into()));
        }
    }
}

// --- Mermaid ------------------------------------------------------------------

fn mermaid(source: &str) -> Extracted {
    let mut lines = source.lines().enumerate().peekable();
    let mut title = None;
    // Frontmatter: `---` … `---`, which may hold `title:`.
    if lines.peek().is_some_and(|(_, l)| l.trim() == "---") {
        lines.next();
        for (_, l) in lines.by_ref() {
            if l.trim() == "---" {
                break;
            }
            if let Some(t) = l.trim().strip_prefix("title:") {
                title = Some(t.trim().trim_matches('"').to_string());
            }
        }
    }
    let body: Vec<(usize, &str)> = lines.map(|(i, l)| (i + 1, l)).collect();
    let Some(&(header_line, header)) = body
        .iter()
        .find(|(_, l)| !l.trim().is_empty() && !l.trim().starts_with("%%"))
    else {
        return Extracted::Unsupported("mermaid (empty)".into());
    };
    let (head, rest) = header
        .trim()
        .split_once(';')
        .map_or((header.trim(), ""), |(h, r)| (h.trim(), r));
    let keyword = head.split_whitespace().next().unwrap_or("");
    // The header line may carry statements after a `;`.
    let mut stmts: Vec<(usize, &str)> = vec![(header_line, rest)];
    stmts.extend(body.iter().filter(|(n, _)| *n > header_line).copied());
    let mut s = match keyword {
        "flowchart" | "graph" | "flowchart-elk" => mermaid_flowchart(&stmts),
        "sequenceDiagram" => mermaid_sequence(&stmts),
        "classDiagram" | "classDiagram-v2" => mermaid_class(&stmts),
        other => return Extracted::Unsupported(format!("mermaid {other}")),
    };
    s.title = title;
    Extracted::Known(s)
}

/// Flowchart statements, split on `;` as well as lines.
fn mermaid_flowchart(lines: &[(usize, &str)]) -> Structure {
    let mut s = Structure::new("flowchart");
    for &(n, line) in lines {
        for stmt in line.split(';') {
            let stmt = stmt.trim();
            let first = stmt.split_whitespace().next().unwrap_or("");
            if stmt.is_empty()
                || stmt.starts_with("%%")
                || [
                    "subgraph",
                    "end",
                    "classDef",
                    "class",
                    "style",
                    "linkStyle",
                    "click",
                    "direction",
                ]
                .contains(&first)
            {
                // `subgraph X [Title]` declares a group, not a node.
                continue;
            }
            if let Err(why) = flow_statement(stmt, &mut s) {
                s.warn(n, why);
            }
        }
    }
    s
}

fn is_id_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `A[x] --> B{y} -->|ok| C & D`: nodes, joined by links, chained.
fn flow_statement(stmt: &str, s: &mut Structure) -> Result<(), String> {
    let chars: Vec<char> = stmt.chars().collect();
    let mut i = 0;
    let mut previous: Vec<String> = vec![];
    let mut pending: Option<Option<String>> = None; // a link waiting for its right-hand nodes
    loop {
        skip_ws(&chars, &mut i);
        if i >= chars.len() {
            break;
        }
        // One group of nodes: `A`, or `A & B`.
        let mut group = vec![];
        loop {
            skip_ws(&chars, &mut i);
            let start = i;
            while i < chars.len() && is_id_char(chars[i]) {
                i += 1;
            }
            if i == start {
                return Err(format!("expected a node id at '{}'", rest(&chars, start)));
            }
            let id: String = chars[start..i].iter().collect();
            shape(&chars, &mut i)?;
            // `:::className` decorates a node.
            if rest(&chars, i).starts_with(":::") {
                i += 3;
                while i < chars.len() && (is_id_char(chars[i]) || chars[i] == '-') {
                    i += 1;
                }
            }
            s.element(&id);
            group.push(id);
            skip_ws(&chars, &mut i);
            if i < chars.len() && chars[i] == '&' {
                i += 1;
                continue;
            }
            break;
        }
        if let Some(label) = pending.take() {
            for a in &previous {
                for b in &group {
                    s.edge(a, b, label.as_deref());
                }
            }
        }
        previous = group;
        skip_ws(&chars, &mut i);
        if i >= chars.len() {
            break;
        }
        pending = Some(flow_link(&chars, &mut i)?);
    }
    if pending.is_some() {
        return Err("a link has no node after it".into());
    }
    Ok(())
}

fn skip_ws(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

fn rest(chars: &[char], i: usize) -> String {
    chars[i.min(chars.len())..].iter().take(24).collect()
}

/// A node's shape and text, from its opening bracket to the matching close.
fn shape(chars: &[char], i: &mut usize) -> Result<(), String> {
    if *i >= chars.len() || !matches!(chars[*i], '[' | '(' | '{' | '>') {
        return Ok(());
    }
    let mut depth = 0i32;
    let mut quoted = false;
    let start = *i;
    while *i < chars.len() {
        let c = chars[*i];
        *i += 1;
        match c {
            '"' => quoted = !quoted,
            '[' | '(' | '{' if !quoted => depth += 1,
            '>' if !quoted && *i - 1 == start => depth += 1,
            ']' | ')' | '}' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Err("a node's text is not closed: a bracket or quote is missing".into())
}

/// `-->`, `---`, `-.->`, `==>`, `--o`, `<-->`, `-->|label|`, `-- label -->`.
/// Returns the label.
fn flow_link(chars: &[char], i: &mut usize) -> Result<Option<String>, String> {
    let start = *i;
    let run = |i: &mut usize| {
        while *i < chars.len() && matches!(chars[*i], '-' | '=' | '.' | '<' | '>') {
            *i += 1;
        }
        // A circle or cross head, when it is the end of the link.
        if *i < chars.len()
            && matches!(chars[*i], 'o' | 'x')
            && *i > 0
            && matches!(chars[*i - 1], '-' | '=')
            && chars.get(*i + 1).is_none_or(|c| c.is_whitespace())
        {
            *i += 1;
        }
    };
    run(i);
    let token: String = chars[start..*i].iter().collect();
    if token.len() < 2 || !(token.contains('-') || token.contains('=')) {
        return Err(format!("expected a link at '{}'", rest(chars, start)));
    }
    skip_ws(chars, i);
    if *i < chars.len() && chars[*i] == '|' {
        let open = *i + 1;
        let close = chars[open..]
            .iter()
            .position(|&c| c == '|')
            .ok_or("a link label is not closed with |")?;
        *i = open + close + 1;
        return Ok(Some(chars[open..open + close].iter().collect()));
    }
    // `A -- text --> B`: an open run with text, then the rest of the link.
    let open_run =
        !token.contains('>') && token.len() <= 3 && !token.ends_with('o') && !token.ends_with('x');
    if open_run {
        let text_start = *i;
        let mut j = *i;
        while j + 1 < chars.len() {
            if matches!(chars[j], '-' | '=' | '.') && matches!(chars[j + 1], '-' | '=' | '.' | '>')
            {
                let label: String = chars[text_start..j].iter().collect();
                *i = j;
                run(i);
                return Ok(Some(label.trim().to_string()));
            }
            j += 1;
        }
    }
    Ok(None)
}

fn mermaid_sequence(lines: &[(usize, &str)]) -> Structure {
    let mut s = Structure::new("sequence");
    let skip = [
        "loop",
        "alt",
        "else",
        "opt",
        "par",
        "and",
        "critical",
        "break",
        "rect",
        "end",
        "note",
        "activate",
        "deactivate",
        "autonumber",
        "box",
        "title",
        "links",
        "link",
        "properties",
        "details",
        "option",
    ];
    for &(_, line) in lines {
        let line = line.trim();
        let first = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if line.is_empty() || line.starts_with("%%") || skip.contains(&first.as_str()) {
            continue;
        }
        if first == "participant" || first == "actor" || first == "create" || first == "destroy" {
            let decl = line
                .split_once(char::is_whitespace)
                .map_or("", |(_, r)| r.trim());
            let decl = decl
                .strip_prefix("participant ")
                .or_else(|| decl.strip_prefix("actor "))
                .unwrap_or(decl);
            // `participant A as Alice`: the id is A.
            let id = decl.split(" as ").next().unwrap_or(decl).trim();
            s.element(id);
            continue;
        }
        // `A->>+B: text`
        let (head, label) = line
            .split_once(':')
            .map_or((line, None), |(h, l)| (h, Some(l)));
        if let Some((from, to)) = split_arrow(
            head,
            &["-->>", "->>", "-->", "->", "--x", "-x", "--)", "-)"],
        ) {
            let to = to.trim_start_matches(['+', '-']).trim();
            s.edge(from.trim(), to, label);
        }
    }
    s
}

/// The first arrow of `arrows` in `head`, and the text on either side.
fn split_arrow<'a>(head: &'a str, arrows: &[&str]) -> Option<(&'a str, &'a str)> {
    let (at, len) = arrows
        .iter()
        .filter_map(|a| head.find(a).map(|at| (at, a.len())))
        .min_by_key(|(at, len)| (*at, usize::MAX - len))?;
    let (from, to) = (&head[..at], &head[at + len..]);
    (!from.trim().is_empty() && !to.trim().is_empty()).then_some((from, to))
}

fn mermaid_class(lines: &[(usize, &str)]) -> Structure {
    let mut s = Structure::new("class");
    let mut in_body = 0;
    for &(n, line) in lines {
        let line = line.trim();
        if in_body > 0 {
            in_body += line.matches('{').count() as i32 - line.matches('}').count() as i32;
            continue;
        }
        if line.is_empty()
            || line.starts_with("%%")
            || line.starts_with("note")
            || line.starts_with("direction")
        {
            continue;
        }
        if let Some(decl) = line.strip_prefix("class ") {
            let name: String = decl
                .trim()
                .chars()
                .take_while(|&c| is_id_char(c) || c == '-')
                .collect();
            s.element(&name);
            if decl.contains('{') && !decl.contains('}') {
                in_body = 1;
            }
            continue;
        }
        if line.starts_with('<') && line.contains(">>") {
            continue; // `<<interface>> Shape`: an annotation
        }
        match relation(line) {
            Some((a, b, label)) => s.edge(&a, &b, label.as_deref()),
            // `Foo : +int x` adds a member to Foo.
            None if line.contains(':') => s.element(line.split(':').next().unwrap().trim()),
            None => s.warn(n, format!("not a class, relation or member: '{line}'")),
        }
    }
    s
}

/// `A "1" *-- "many" B : label`, `A<|--B`, `[A] ..> [B]`: two ends and a label.
/// Shared by Mermaid class diagrams and every PlantUML relation.
fn relation(line: &str) -> Option<(String, String, Option<String>)> {
    let (head, label) = match line.find(" : ").or_else(|| {
        line.rfind(':').filter(|&i| {
            !line[..i].contains('"') || line[..i].matches('"').count().is_multiple_of(2)
        })
    }) {
        Some(i) => (
            &line[..i],
            Some(
                line[i + 1..]
                    .trim()
                    .trim_start_matches(':')
                    .trim()
                    .to_string(),
            ),
        ),
        None => (line, None),
    };
    let chars: Vec<char> = head.chars().collect();
    // The arrow's core: a `--` or `..`, then widened to its heads.
    let core = (0..chars.len().saturating_sub(1)).find(|&i| {
        let (a, b) = (chars[i], chars[i + 1]);
        (a == '-' || a == '.') && (b == '-' || b == '.' || b == '>' || b == '[')
            || a == '<' && (b == '-' || b == '.' || b == '|')
    })?;
    let rel = |c: char| {
        matches!(
            c,
            '-' | '.'
                | '<'
                | '>'
                | '|'
                | '*'
                | '+'
                | '#'
                | '^'
                | '}'
                | '{'
                | '['
                | ']'
                | '('
                | ')'
                | '@'
        )
    };
    let mut l = core;
    while l > 0
        && (rel(chars[l - 1])
            || (matches!(chars[l - 1], 'o' | 'x') && (l < 2 || !is_id_char(chars[l - 2]))))
    {
        // A `[` that closes a component name belongs to the name, not the arrow.
        if chars[l - 1] == ']' {
            break;
        }
        l -= 1;
    }
    let mut r = core;
    let mut in_style = false;
    while r < chars.len() {
        let c = chars[r];
        if c == '[' && r > core && chars[r - 1] == '-' {
            in_style = true; // `-[#red]->`: style inside the arrow
        }
        if in_style {
            if c == ']' {
                in_style = false;
            }
            r += 1;
            continue;
        }
        let tail = matches!(c, 'o' | 'x') && chars.get(r + 1).is_none_or(|n| !is_id_char(*n));
        if (rel(c) && c != '[' && c != '(') || tail {
            r += 1;
        } else {
            break;
        }
    }
    let left: String = chars[..l].iter().collect();
    let right: String = chars[r..].iter().collect();
    let (a, b) = (end_name(&left, true)?, end_name(&right, false)?);
    Some((a, b, label.filter(|l| !l.is_empty())))
}

/// The element named at one end of a relation, without its cardinality,
/// brackets or quotes: `Foo "1"` → Foo, `[Web]` → Web.
fn end_name(text: &str, left: bool) -> Option<String> {
    let mut t = text.trim().to_string();
    // Drop a cardinality next to the arrow: `Foo "1"` / `"*" Bar`.
    if left && t.ends_with('"') {
        if let Some(i) = t[..t.len() - 1].rfind('"') {
            t.truncate(i);
        }
    } else if !left
        && t.starts_with('"')
        && let Some(i) = t[1..].find('"')
    {
        t = t[i + 2..].to_string();
    }
    let t = t.trim();
    let name = if let Some(inner) = t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        inner.to_string()
    } else if let Some(inner) = t.strip_prefix("()").map(str::trim) {
        inner.trim_matches('"').to_string()
    } else {
        t.trim_matches('"')
            .trim_end_matches(['+', '-'])
            .trim_start_matches(['+', '-'])
            .to_string()
    };
    let name = name.trim().to_string();
    (!name.is_empty() && !name.contains(char::is_whitespace)
        || t.starts_with('[')
        || t.starts_with('"'))
    .then_some(name)
    .filter(|n| !n.is_empty())
}

// --- PlantUML -----------------------------------------------------------------

const PARTICIPANTS: [&str; 9] = [
    "participant",
    "actor",
    "boundary",
    "control",
    "entity",
    "database",
    "collections",
    "queue",
    "person",
];
const CLASSES: [&str; 6] = [
    "class",
    "abstract",
    "interface",
    "enum",
    "annotation",
    "struct",
];
const COMPONENTS: [&str; 10] = [
    "component",
    "node",
    "cloud",
    "frame",
    "folder",
    "artifact",
    "storage",
    "card",
    "rectangle",
    "package",
];

fn plantuml(source: &str) -> Extracted {
    let mut title = None;
    let mut lines: Vec<(usize, &str)> = vec![];
    let mut block_comment = false;
    for (i, raw) in source.lines().enumerate() {
        let l = raw.trim();
        if block_comment {
            block_comment = !l.ends_with("'/");
            continue;
        }
        if l.starts_with("/'") {
            block_comment = !l.ends_with("'/") || l.len() < 4;
            continue;
        }
        if l.is_empty()
            || l.starts_with('\'')
            || l.starts_with('@')
            || l.starts_with('!')
            || l.starts_with("skinparam")
            || l.starts_with("hide ")
            || l.starts_with("show ")
        {
            continue;
        }
        if let Some(t) = l.strip_prefix("title ") {
            title = Some(t.trim().to_string());
            continue;
        }
        lines.push((i + 1, l));
    }
    let first = |l: &str| {
        l.split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let kind = if lines
        .iter()
        .any(|(_, l)| CLASSES.contains(&first(l).as_str()) && !l.contains("()"))
    {
        "class"
    } else if lines.iter().any(|(_, l)| {
        COMPONENTS.contains(&first(l).as_str()) || l.starts_with('[') || l.starts_with("()")
    }) {
        "component"
    } else if lines.iter().any(|(_, l)| {
        PARTICIPANTS.contains(&first(l).as_str()) || l.contains("->") || l.contains("<-")
    }) {
        "sequence"
    } else if lines
        .iter()
        .any(|(_, l)| l.starts_with("start") || l.starts_with(':'))
    {
        return Extracted::Unsupported("plantuml activity".into());
    } else {
        return Extracted::Unsupported("plantuml".into());
    };
    let mut s = Structure::new(kind);
    s.title = title;
    match kind {
        "sequence" => plantuml_sequence(&lines, &mut s),
        "class" => plantuml_class(&lines, &mut s),
        _ => plantuml_component(&lines, &mut s),
    }
    Extracted::Known(s)
}

/// `participant "Long name" as L`, `database Store`: the name anchors use is
/// the alias when there is one.
fn declared(decl: &str) -> String {
    let decl = decl.trim();
    let decl = decl.split(" #").next().unwrap_or(decl).trim(); // a colour
    let decl = decl.split(" order ").next().unwrap_or(decl);
    let decl = decl.trim_end_matches('{').trim();
    match decl.split_once(" as ") {
        Some((_, alias)) => alias
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches('"')
            .to_string(),
        None => decl
            .trim_matches('"')
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split_whitespace()
            .next()
            .map_or(String::new(), |_| {
                if decl.starts_with('"') || decl.starts_with('[') {
                    decl.trim_matches('"')
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .to_string()
                } else {
                    decl.split_whitespace()
                        .next()
                        .unwrap_or("")
                        .split('<')
                        .next()
                        .unwrap_or("")
                        .to_string()
                }
            }),
    }
}

fn plantuml_sequence(lines: &[(usize, &str)], s: &mut Structure) {
    let skip = [
        "loop",
        "alt",
        "else",
        "opt",
        "par",
        "group",
        "break",
        "critical",
        "end",
        "note",
        "activate",
        "deactivate",
        "destroy",
        "autonumber",
        "ref",
        "box",
        "hnote",
        "rnote",
        "return",
        "newpage",
        "...",
        "|||",
        "==",
        "delay",
        "autoactivate",
        "create",
    ];
    for &(_, line) in lines {
        let f = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if skip.contains(&f.as_str())
            || line.starts_with("...")
            || line.starts_with("==")
            || line.starts_with("|||")
        {
            continue;
        }
        if PARTICIPANTS.contains(&f.as_str()) {
            s.element(&declared(
                line.split_once(char::is_whitespace).map_or("", |(_, r)| r),
            ));
            continue;
        }
        let (head, label) = line
            .split_once(':')
            .map_or((line, None), |(h, l)| (h, Some(l)));
        let Some((a, arrow, b)) = seq_arrow(head) else {
            continue;
        };
        // A message to or from the diagram's edge (`[->`) names no participant.
        if a.is_empty() || b.is_empty() || a == "[" || b == "]" {
            continue;
        }
        let backwards = arrow.starts_with('<') && !arrow.ends_with('>');
        let (from, to) = if backwards { (b, a) } else { (a, b) };
        s.edge(&from, &to, label);
    }
}

/// `A -> B`, `A-->>B`, `A <- B`, `A -[#red]> B`, `A ->x B`: (left, arrow, right).
fn seq_arrow(head: &str) -> Option<(String, String, String)> {
    let chars: Vec<char> = head.chars().collect();
    let name_end = |from: usize| -> usize {
        let mut i = from;
        if chars.get(i) == Some(&'"') {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                i += 1;
            }
            return (i + 1).min(chars.len());
        }
        while i < chars.len() && (is_id_char(chars[i]) || chars[i] == '.') {
            i += 1;
        }
        i
    };
    let mut i = 0;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let a_start = i;
    i = name_end(i);
    let a: String = chars[a_start..i].iter().collect();
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let arrow_start = i;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '-' | '<' | '>' | '/' | '\\' | '?') {
            i += 1;
        } else if c == '[' && i > arrow_start {
            while i < chars.len() && chars[i] != ']' {
                i += 1;
            }
            i += 1;
        } else if matches!(c, 'x' | 'o')
            && i > arrow_start
            && chars.get(i + 1).is_none_or(|n| n.is_whitespace())
        {
            i += 1;
        } else {
            break;
        }
    }
    let arrow: String = chars[arrow_start..i.min(chars.len())].iter().collect();
    if !arrow.contains('-')
        || !(arrow.contains('>')
            || arrow.contains('<')
            || arrow.contains('/')
            || arrow.contains('\\'))
    {
        return None;
    }
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let b_start = i;
    let b_end = name_end(i);
    let b: String = chars[b_start..b_end].iter().collect();
    let clean = |s: String| {
        s.trim_matches('"')
            .trim_end_matches(['+', '-', '*', '!'])
            .to_string()
    };
    Some((clean(a), arrow, clean(b)))
}

/// Containers (`package X {`) qualify what they hold, `X.Name`, and are
/// elements themselves: what the rendered SVG names, so what anchors use.
struct Containers(Vec<String>);

impl Containers {
    /// Returns true when the line opened or closed a container.
    fn track(&mut self, line: &str, keywords: &[&str], s: &mut Structure) -> bool {
        let f = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if line == "}" {
            self.0.pop();
            return true;
        }
        if keywords.contains(&f.as_str()) && line.trim_end().ends_with('{') {
            let name = declared(line.split_once(char::is_whitespace).map_or("", |(_, r)| r));
            let full = self.qualify(&name);
            s.element(&full);
            self.0.push(full);
            return true;
        }
        false
    }
    fn qualify(&self, name: &str) -> String {
        match self.0.last() {
            Some(parent) => format!("{parent}.{name}"),
            None => name.to_string(),
        }
    }
}

fn plantuml_class(lines: &[(usize, &str)], s: &mut Structure) {
    let mut depth = 0i32;
    let mut containers = Containers(vec![]);
    for &(n, line) in lines {
        if depth > 0 {
            depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
            continue;
        }
        if containers.track(line, &["package", "namespace"], s) {
            continue;
        }
        let f = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(f.as_str(), "together" | "note" | "legend" | "end") {
            continue;
        }
        if CLASSES.contains(&f.as_str()) {
            let mut decl = line
                .split_once(char::is_whitespace)
                .map_or("", |(_, r)| r)
                .trim();
            if f == "abstract" {
                decl = decl.strip_prefix("class ").unwrap_or(decl);
            }
            let decl = decl
                .split(" extends ")
                .next()
                .unwrap_or(decl)
                .split(" implements ")
                .next()
                .unwrap_or(decl);
            s.element(&containers.qualify(&declared(decl)));
            if line.contains('{') && !line.contains('}') {
                depth = 1;
            }
            continue;
        }
        match relation(line) {
            Some((a, b, label)) => s.edge(&a, &b, label.as_deref()),
            None if line.contains(" : ") || line.contains(':') => {}
            None => s.warn(n, format!("not a class or relation: '{line}'")),
        }
    }
}

fn plantuml_component(lines: &[(usize, &str)], s: &mut Structure) {
    let mut containers = Containers(vec![]);
    for &(_, line) in lines {
        if containers.track(
            line,
            &[
                "package",
                "node",
                "cloud",
                "frame",
                "folder",
                "rectangle",
                "database",
            ],
            s,
        ) {
            continue;
        }
        let f = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(f.as_str(), "note" | "end" | "legend") {
            continue;
        }
        if let Some((a, b, label)) = relation(line) {
            s.edge(&a, &b, label.as_deref());
            continue;
        }
        let name = if COMPONENTS.contains(&f.as_str())
            || ["interface", "database", "actor", "queue"].contains(&f.as_str())
        {
            declared(line.split_once(char::is_whitespace).map_or("", |(_, r)| r))
        } else if line.starts_with('[') {
            declared(line)
        } else if let Some(r) = line.strip_prefix("()") {
            declared(r)
        } else {
            continue;
        };
        s.element(&containers.qualify(&name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(lang: &str, src: &str) -> Structure {
        match extract(lang, src) {
            Extracted::Known(s) => s,
            Extracted::Unsupported(t) => panic!("unsupported: {t}"),
        }
    }

    #[test]
    fn flowchart_with_shapes_labels_and_chains() {
        let s = known(
            "mermaid",
            "flowchart LR; A[Cart] --> B{Pay}; B -->|ok| C[Done]",
        );
        assert_eq!(s.elements, ["A", "B", "C"]);
        assert_eq!(
            s.edges[1],
            Edge {
                from: "B".into(),
                to: "C".into(),
                label: Some("ok".into())
            }
        );
        let s = known(
            "mermaid",
            "graph TD\n  A -- text --> B --> C & D\n  E((round)) -.-> F",
        );
        assert_eq!(s.elements, ["A", "B", "C", "D", "E", "F"]);
        assert_eq!(s.edges.len(), 4);
        assert_eq!(s.edges[0].label.as_deref(), Some("text"));
    }

    #[test]
    fn flowchart_reports_an_unclosed_bracket() {
        let s = known("mermaid", "flowchart TD\n  A --> B\n  B --> C[oops\n");
        assert_eq!(s.warning.as_ref().map(|w| w.0), Some(3));
    }

    #[test]
    fn unsupported_types_say_what_they_are() {
        assert!(
            matches!(extract("mermaid", "gantt\n  title x"), Extracted::Unsupported(t) if t == "mermaid gantt")
        );
    }

    #[test]
    fn plantuml_sequence_uses_aliases_and_direction() {
        let s = known(
            "plantuml",
            "@startuml\nparticipant \"Web client\" as C\ndatabase Store\nC -> Server : hello\nServer <-- Store : rows\n@enduml",
        );
        assert_eq!(s.kind, "sequence");
        assert_eq!(s.elements, ["C", "Store", "Server"]);
        assert_eq!(
            s.edges[1],
            Edge {
                from: "Store".into(),
                to: "Server".into(),
                label: Some("rows".into())
            }
        );
    }

    #[test]
    fn plantuml_class_relations_and_bodies() {
        let s = known(
            "plantuml",
            "@startuml\ntitle Model\nclass A {\n  +x: int\n}\nabstract class B\nA \"1\" *-- \"many\" B : owns\nB <|-- C\n@enduml",
        );
        assert_eq!((s.kind, s.title.as_deref()), ("class", Some("Model")));
        assert_eq!(s.elements, ["A", "B", "C"]);
        assert_eq!(s.edges[0].label.as_deref(), Some("owns"));
    }

    #[test]
    fn plantuml_components() {
        let s = known(
            "plantuml",
            "@startuml\n[Web] --> [API] : REST\ncomponent Worker\nAPI ..> Worker\n@enduml",
        );
        assert_eq!(s.kind, "component");
        assert_eq!(s.elements, ["Web", "API", "Worker"]);
    }
}
