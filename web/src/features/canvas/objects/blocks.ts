/**
 * Passages of a note as link anchors (canvas/text-anchors).
 *
 * A block is a paragraph, a list item or a heading. A paragraph or list item
 * is named by a trailing ` ^id` (Obsidian's block reference); a heading by its
 * slug, or by a `^id` if it has one. The name lives in the source, so a deleted
 * paragraph breaks its links rather than re-pointing them.
 *
 * Blocks are found by scanning source lines, the same way `server/src/agent/blocks.rs`
 * does, and in the order the rendered note shows them: headings, list items
 * and paragraphs, skipping fenced code. That order is how a click on a block
 * in the drawing finds its lines in the source.
 */

import { frontmatterLines } from './status';

const MARKER = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const FENCE = /^[ \t]*(```|~~~)/;
const QUOTE = /^[ \t]*>[ \t]?/;

export interface SourceBlock {
  readonly kind: 'heading' | 'item' | 'paragraph';
  /** `^id` or a heading's slug, when the block has a name. */
  readonly name: string | undefined;
  /** The block's lines, first to last (indices into the source's lines). */
  readonly first: number;
  readonly last: number;
  /** Its text without Markdown syntax or marker, for matching to the drawing. */
  readonly text: string;
}

/** A heading's slug: lowercase, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Letters and digits only, lowercased: what a drawn block and its source share. */
export function plain(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Every block of a note, in reading order. */
export function sourceBlocks(source: string): SourceBlock[] {
  const lines = source.split(/\r\n|\r|\n/);
  const blocks: SourceBlock[] = [];
  const slugs = new Map<string, number>();
  let fenced = false;
  let open: { kind: 'item' | 'paragraph'; first: number; last: number } | undefined;
  const close = () => {
    if (!open) return;
    const own = lines.slice(open.first, open.last + 1);
    const lastLine = own.at(-1) ?? '';
    const marker = MARKER.exec(lastLine)?.[1];
    const text = own
      .map((l, i) => (i === own.length - 1 ? l.replace(MARKER, '') : l))
      .join(' ')
      .replace(QUOTE, '')
      .replace(ITEM, '');
    blocks.push({
      kind: open.kind,
      name: marker ? `^${marker}` : undefined,
      first: open.first,
      last: open.last,
      text,
    });
    open = undefined;
  };
  // Frontmatter is not drawn, so it holds no passages (canvas/note-status).
  const skip = frontmatterLines(source);
  lines.forEach((raw, n) => {
    if (n < skip) return;
    if (FENCE.test(raw)) {
      close();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = raw.replace(QUOTE, '');
    if (!line.trim()) {
      close();
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const body = heading[2] ?? '';
      const marker = MARKER.exec(body)?.[1];
      const text = body.replace(MARKER, '');
      let name = marker ? `^${marker}` : slug(text);
      if (!marker) {
        // GitHub's rule: a repeated slug takes -1, -2 …
        const seen = slugs.get(name) ?? 0;
        slugs.set(name, seen + 1);
        if (seen > 0) name = `${name}-${seen}`;
      }
      blocks.push({ kind: 'heading', name: name || undefined, first: n, last: n, text });
      return;
    }
    if (ITEM.test(line)) {
      close();
      open = { kind: 'item', first: n, last: n };
      return;
    }
    if (open) open.last = n;
    else open = { kind: 'paragraph', first: n, last: n };
  });
  close();
  return blocks;
}

/** Block names a note has, for refusing a link to one it does not. */
export function blockNames(source: string): string[] {
  return sourceBlocks(source).flatMap((b) => (b.name ? [b.name] : []));
}

/** A fresh `^id` not used in this note. */
export function newBlockId(source: string, random: () => number = Math.random): string {
  const taken = new Set(blockNames(source));
  for (;;) {
    const id = `^${Math.floor(random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0')}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The source with the `index`-th block (reading order) named, and its name; or
 * nothing when that block is not the drawn text `drawn` (the drawing and the
 * source disagree, so the passage cannot be named safely) or already has one.
 */
export function nameBlock(
  source: string,
  index: number,
  drawn: string,
  random?: () => number,
): { source: string; name: string } | undefined {
  const block = sourceBlocks(source)[index];
  if (!block || block.kind === 'heading' || block.name) return undefined;
  const want = plain(drawn);
  if (!want || plain(block.text).slice(0, 24) !== want.slice(0, 24)) return undefined;
  const name = newBlockId(source, random);
  const lines = source.split(/(\r\n|\r|\n)/);
  // `split` with a capture keeps the separators at odd indices.
  const at = block.last * 2;
  lines[at] = `${(lines[at] ?? '').replace(/[ \t]+$/, '')} ${name}`;
  return { source: lines.join(''), name };
}
