/**
 * A note's status (canvas/note-status): a decision or a question, and where it
 * stands, read from the note's source. Nothing is stored. The server reads it
 * the same way (`server/src/agent/status.rs`); `note-status.json` keeps the
 * two in step.
 */

const FRONTMATTER_LINES = 20;
const STATUS_LINES = 3;
const HEADING = /^ {0,3}#{1,6}[ \t]/;

export const STATES = {
  decision: ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'],
  question: ['open', 'answered'],
} as const;

export type StatusKind = keyof typeof STATES | 'none';

export interface NoteStatus {
  readonly kind: StatusKind;
  readonly state: string | null;
  /** The value as written, bold markers dropped. */
  readonly raw: string;
}

interface Declared extends NoteStatus {
  /** The source line the value is on, and whether it is frontmatter. */
  readonly line: number;
  readonly frontmatter: boolean;
}

/** The index of frontmatter's closing `---`, if the source opens with one that closes in time. */
function frontmatterEnd(lines: readonly string[]): number | undefined {
  if (lines[0]?.trimEnd() !== '---') return undefined;
  for (let n = 1; n < Math.min(lines.length, FRONTMATTER_LINES + 1); n++) {
    if (lines[n]?.trimEnd() === '---') return n;
  }
  return undefined;
}

/** How many leading lines are frontmatter (0 when there is none). */
export function frontmatterLines(source: string): number {
  const end = frontmatterEnd(source.split('\n'));
  return end === undefined ? 0 : end + 1;
}

/** The source with leading frontmatter removed: what a note renders. */
export function stripFrontmatter(source: string): string {
  const n = frontmatterLines(source);
  return n === 0 ? source : source.split('\n').slice(n).join('\n');
}

function matched(value: string): NoteStatus | undefined {
  const raw = value.replace(/\*/g, '').trim();
  if (raw === '') return undefined;
  const word =
    raw
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .find((w) => w !== '') ?? '';
  for (const kind of ['decision', 'question'] as const) {
    if ((STATES[kind] as readonly string[]).includes(word)) return { kind, state: word, raw };
  }
  return { kind: 'none', state: null, raw };
}

function statusLine(line: string): string | undefined {
  const plain = line.replace(/\*/g, '').trim();
  return /^S(tatus|TATUS):/.test(plain) ? plain.slice(7).trim() : undefined;
}

function declared(source: string): Declared | undefined {
  const lines = source.split('\n');
  const end = frontmatterEnd(lines);
  if (end !== undefined) {
    for (let n = 1; n < end; n++) {
      const m = /^\s*status\s*:(.*)$/i.exec(lines[n] ?? '');
      if (m) {
        const s = matched((m[1] ?? '').trim().replace(/^["']|["']$/g, ''));
        return s && { ...s, line: n, frontmatter: true };
      }
    }
  }
  const near: number[] = [];
  for (
    let n = end === undefined ? 0 : end + 1;
    n < lines.length && near.length <= STATUS_LINES;
    n++
  ) {
    if ((lines[n] ?? '').trim() !== '') near.push(n);
  }
  const top = near[0];
  if (top !== undefined && HEADING.test((lines[top] ?? '').trim())) near.shift();
  for (const n of near.slice(0, STATUS_LINES)) {
    const value = statusLine(lines[n] ?? '');
    if (value !== undefined) {
      const s = matched(value);
      return s && { ...s, line: n, frontmatter: false };
    }
  }
  return undefined;
}

export function noteStatus(source: string): NoteStatus | undefined {
  const d = declared(source);
  return d && { kind: d.kind, state: d.state, raw: d.raw };
}

/** "Decision · Accepted", or the word as written when the board does not know it. */
export function statusLabel(s: NoteStatus): string {
  if (s.state === null) return s.raw;
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  return `${cap(s.kind)} · ${cap(s.state)}`;
}

/**
 * The source with its status set to `state`, wherever it was declared. A
 * `Status:` line keeps its bold markers and a trailing date in parentheses.
 * Undefined when the note declares no status.
 */
export function withStatus(source: string, state: string): string | undefined {
  const d = declared(source);
  if (!d) return undefined;
  const lines = source.split('\n');
  const line = lines[d.line] ?? '';
  if (d.frontmatter) {
    lines[d.line] = line.replace(/^(\s*status\s*:\s*["']?)[^"']*?(["']?\s*)$/i, `$1${state}$2`);
  } else {
    const word = state.charAt(0).toUpperCase() + state.slice(1);
    // `**Status:** ` or `**Status: ` up to the value; then a closing `**` and a `(date)` to keep.
    const m = /^(\s*\**\s*Status:\s*\**\s*)(.*?)(\s*\*\*)?(\s*\([^)]*\))?\s*$/i.exec(line);
    if (!m) return undefined;
    lines[d.line] = `${m[1]}${word}${m[3] ?? ''}${m[4] ?? ''}`;
  }
  return lines.join('\n');
}
