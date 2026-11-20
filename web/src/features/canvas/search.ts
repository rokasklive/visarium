import type { CanvasDocument, CanvasItem, GroupId, ItemId, Rect } from '@visarium/canvas-core';
import type { LocalRect } from './objects/layout';

/**
 * Quick search over the open board (canvas/quick-search).
 *
 * The text searched is the text the layout draws: `textIndex` runs over the
 * same markup `objects/layout.ts` renders, so every occurrence the counter
 * counts is one `measureOccurrences` can find and highlight.
 */

export type SearchTarget =
  | { readonly kind: 'item'; readonly id: ItemId }
  | { readonly kind: 'group'; readonly id: GroupId };

/** One occurrence of the query: the `nth` one in its target's text. */
export interface SearchResult {
  readonly target: SearchTarget;
  readonly nth: number;
}

export function targetKey(t: SearchTarget): string {
  return `${t.kind}:${t.id}`;
}

/** Elements whose text is never drawn. */
const UNDRAWN = new Set(['style', 'script', 'title', 'desc']);
/** What separates one passage from the next, so a match never spans two. */
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div, text, foreignObject';

export interface TextIndex {
  /** Every drawn text node in reading order, passages separated by `\n`. */
  readonly text: string;
  readonly runs: readonly { readonly node: Text; readonly start: number }[];
}

/** The drawn text under `root`, and where each text node starts in it. */
export function textIndex(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs: { node: Text; start: number }[] = [];
  let text = '';
  let block: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || UNDRAWN.has(parent.localName)) continue;
    const data = (node as Text).data;
    if (data === '') continue;
    const own = parent.closest(BLOCK);
    // Whitespace between passages is source formatting, not drawn text; inside
    // one it is the space between two inline runs.
    if (data.trim() === '' && own !== block) continue;
    if (block !== undefined && own !== block) text += '\n';
    block = own;
    runs.push({ node: node as Text, start: text.length });
    text += data;
  }
  return { text, runs };
}

/** Where `query` starts in `text`, case-insensitively, without overlaps. */
export function occurrences(text: string, query: string): number[] {
  const q = query.toLocaleLowerCase();
  if (!q.trim()) return [];
  // ponytail: assumes lowercasing keeps lengths (true outside a few scripts,
  // e.g. Turkish İ); offsets would drift by a character there.
  const hay = text.toLocaleLowerCase();
  const out: number[] = [];
  for (let at = hay.indexOf(q); at !== -1; at = hay.indexOf(q, at + q.length)) out.push(at);
  return out;
}

/**
 * The rectangles of each occurrence of `query` under a MOUNTED `root`,
 * relative to `origin`. An occurrence that wraps across lines has several.
 */
export function measureIn(root: Node, origin: DOMRect, query: string): LocalRect[][] {
  const { text, runs } = textIndex(root);
  const doc = root.ownerDocument ?? (root as Document);
  const point = (offset: number): [Text, number] => {
    let lo = 0;
    for (let i = 0; i < runs.length; i++) {
      if ((runs[i] as (typeof runs)[number]).start <= offset) lo = i;
      else break;
    }
    const run = runs[lo] as (typeof runs)[number];
    return [run.node, Math.min(offset - run.start, run.node.data.length)];
  };
  return occurrences(text, query).map((start) => {
    const range = doc.createRange();
    const [a, ai] = point(start);
    const [b, bi] = point(start + query.length);
    range.setStart(a, ai);
    range.setEnd(b, bi);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) {
      // SVG text in engines that return no client rects for a Range.
      const owner = a.parentElement as unknown as SVGTextContentElement | null;
      if (owner && typeof owner.getExtentOfChar === 'function') {
        try {
          const first = owner.getExtentOfChar(ai);
          const last = owner.getExtentOfChar(Math.max(ai, ai + query.length - 1));
          const m = owner.getScreenCTM?.();
          const sx = m?.a ?? 1;
          const sy = m?.d ?? 1;
          return [
            {
              x: (m?.e ?? 0) + first.x * sx - origin.left,
              y: (m?.f ?? 0) + first.y * sy - origin.top,
              width: (last.x + last.width - first.x) * sx,
              height: first.height * sy,
            },
          ];
        } catch {
          return [];
        }
      }
    }
    return lines(rects).map((r) => ({
      x: r.left - origin.left,
      y: r.top - origin.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
    }));
  });
}

/**
 * One box per drawn line. A Range reports a box per inline fragment — the
 * space at a wrap, a bold word — and two on one line would overlap their
 * translucent fill into a darker patch.
 */
function lines(rects: readonly DOMRect[]) {
  const out: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const r of rects) {
    const mid = (r.top + r.bottom) / 2;
    const line = out.find((l) => mid > l.top && mid < l.bottom);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

/**
 * Text for an object that has no layout yet (off screen): the same passages
 * its drawing would hold, as nearly as can be had without rendering.
 */
export function fallbackText(item: CanvasItem, markdown?: (source: string) => string): string {
  const c = item.content;
  switch (c.kind) {
    case 'note':
      return markdown ? textIndex(htmlRoot(markdown(c.source))).text : c.source;
    case 'checklist':
      return [c.title, ...c.tasks.map((t) => t.text)].filter(Boolean).join('\n');
    case 'diagram':
      // Labels sit inside brackets and quotes in both Mermaid and PlantUML.
      return [...c.source.matchAll(/\[([^\]\n]*)\]|\(([^)\n]*)\)|\{([^}\n]*)\}|"([^"\n]*)"/g)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')
        .map((s) => s.replace(/^[[({"]+|[\])}"]+$/g, ''))
        .filter(Boolean)
        .join('\n');
    default:
      return '';
  }
}

function htmlRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/**
 * Every occurrence on the board, in board order: targets top-to-bottom then
 * left-to-right, occurrences in reading order within each.
 *
 * ponytail: one linear scan per query over every item; a prebuilt index if the
 * bench board shows a stall.
 */
export function findResults(
  doc: CanvasDocument,
  query: string,
  textOf: (item: CanvasItem) => string,
): SearchResult[] {
  if (!query.trim()) return [];
  const hits: { target: SearchTarget; bounds: Rect; count: number }[] = [];
  for (const item of doc.items()) {
    const count = occurrences(textOf(item), query).length;
    const bounds = count > 0 ? doc.index.boundsOf(item.id) : undefined;
    if (bounds) hits.push({ target: { kind: 'item', id: item.id }, bounds, count });
  }
  for (const group of doc.groups()) {
    const count = group.label ? occurrences(group.label, query).length : 0;
    const bounds = count > 0 ? doc.groupBounds(group.id) : undefined;
    if (bounds) hits.push({ target: { kind: 'group', id: group.id }, bounds, count });
  }
  hits.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  return hits.flatMap((h) =>
    Array.from({ length: h.count }, (_, nth) => ({ target: h.target, nth })),
  );
}
