/**
 * The design system, as a test rather than a promise.
 *
 * Two rules from docs/product/DESIGN_SYSTEM.md are the kind that decay quietly:
 * a colour gets hardcoded because a token was one import away, and a token gets
 * nudged darker because it looked nicer, taking a contrast ratio below AA with
 * it. Neither shows up in review. Both show up here.
 *
 * Same reasoning as canvas-core's boundaries.test.ts: a lint rule is easy to
 * disable in a hurry, a failing test is harder to talk past.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
const APP_CSS = join(REPO, 'web', 'src', 'styles', 'app.css');

// -- Rule: colour is chosen in exactly one place ---------------------------

/**
 * Hex, every CSS colour function, and a bare colour word that is the whole
 * string — `fill="white"` is as much a second palette as `#fff` is.
 *
 * ponytail: the named-colour list is the common ones, not all 148. A test that
 * flags the word "tan" in prose gets deleted, which is worse than a gap.
 */
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|['"`](?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|magenta|silver|gold)['"`]/;

function sourcesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => extensions.some((e) => f.endsWith(e)))
    .filter((f) => !/\.test\.tsx?$|routeTree\.gen\.ts$|node_modules|[/\\]dist[/\\]/.test(f))
    .map((f) => join(dir, f));
}

const scanned = [
  ...sourcesUnder(join(REPO, 'web', 'src'), ['.ts', '.tsx', '.css']).filter((f) => f !== APP_CSS),
  ...readdirSync(join(REPO, 'packages')).flatMap((pkg) => {
    try {
      return sourcesUnder(join(REPO, 'packages', pkg, 'src'), ['.ts', '.tsx']).filter(
        (f) => !f.includes('generated'),
      );
    } catch {
      return [];
    }
  }),
];

describe('colour is chosen in exactly one place', () => {
  it('has sources to check', () => {
    expect(scanned.length).toBeGreaterThan(20);
  });

  for (const file of scanned) {
    it(`${file.slice(REPO.length + 1)} contains no colour literal`, () => {
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => COLOUR_LITERAL.test(line));

      expect(
        offending.map(([n, line]) => `${n}: ${line.trim()}`),
        'use a token from app.css, via canvas-theme.ts on the canvas',
      ).toEqual([]);
    });
  }
});

// -- Rule: chrome holds WCAG 2.2 AA ---------------------------------------

/** oklch() as written in app.css. Alpha is ignored: it composites, it is not a pair. */
function tokens(): Map<string, [number, number, number]> {
  const css = readFileSync(APP_CSS, 'utf8');
  const found = new Map<string, [number, number, number]>();
  for (const [, name, l, c, h] of css.matchAll(
    /--color-([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/g,
  )) {
    found.set(name as string, [Number(l), Number(c), Number(h)]);
  }
  return found;
}

/** oklch to linear sRGB, then WCAG relative luminance. Ottosson's matrices. */
function luminance([L, C, h]: [number, number, number]): number {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string, bg: string): number {
  const t = tokens();
  const a = luminance(t.get(fg) as [number, number, number]);
  const b = luminance(t.get(bg) as [number, number, number]);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Each token against the grounds it is actually drawn on. A cross product would
 * flag pairs that never render — a disabled control never sits on
 * `surface-raised`, because `enabled:hover:` is what keeps a dead control from
 * lighting up — and a test that reports impossible failures is a test that gets
 * deleted rather than fixed.
 */
const CHROME = ['surface', 'surface-raised', 'surface-sunken'] as const;
/** The floating canvas toolbar: its own fill inside, the canvas ground outside. */
const FLOATING = ['surface', 'surface-sunken'] as const;

describe('chrome holds WCAG 2.2 AA', () => {
  it('reads the tokens it is asserting about', () => {
    expect([...tokens().keys()]).toEqual(
      expect.arrayContaining(['ink', 'ink-dim', 'ink-disabled', 'accent', 'line-strong']),
    );
  });

  for (const ink of ['ink', 'ink-dim', 'accent'] as const) {
    for (const ground of CHROME) {
      it(`${ink} on ${ground} clears 4.5:1 for text`, () => {
        expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // 1.4.11: a border that is the only thing marking a control's boundary.
  for (const ground of FLOATING) {
    it(`line-strong on ${ground} clears 3:1 as a boundary`, () => {
      expect(contrast('line-strong', ground)).toBeGreaterThanOrEqual(3);
    });
  }

  // Inactive controls are exempt from 1.4.3, but exemption is not a licence to
  // be unreadable at 13px. The opacity-40 this replaced computed to 1.96:1.
  for (const ground of FLOATING) {
    it(`ink-disabled on ${ground} stays legible at 3:1`, () => {
      expect(contrast('ink-disabled', ground)).toBeGreaterThanOrEqual(3);
    });
  }

  it('keeps line decorative, so it is never mistaken for a boundary', () => {
    expect(contrast('line', 'surface')).toBeLessThan(3);
  });

  // Two tokens that render the same colour are one token and a bug.
  it('keeps line-strong distinguishable from ink-disabled', () => {
    expect(contrast('line-strong', 'ink-disabled')).not.toBe(1);
  });
});

// -- Rule: the annotation system is faint by measurement -------------------

/**
 * The ground grid gives an empty board a sense of scale, and its whole job is
 * to be almost invisible — so "subtle" is a band, not a vibe: loud enough to
 * find when looked for (a floor), far below anything that could read as a
 * boundary or compete with content (a ceiling). A nudge in either direction
 * fails here rather than shipping. The grid is 2px dots, not hairlines: a dot
 * carries a fraction of a line's ink, so its band sits higher than a line's
 * would.
 */
describe('the ground grid', () => {
  it('stays inside its subtle band above the canvas ground', () => {
    const ratio = contrast('grid', 'surface-sunken');
    expect(ratio).toBeGreaterThanOrEqual(1.3);
    expect(ratio).toBeLessThanOrEqual(1.6);
  });

  it('stays quieter than any real boundary on the same ground', () => {
    expect(contrast('grid', 'surface-sunken')).toBeLessThan(
      contrast('line-strong', 'surface-sunken'),
    );
  });

  it('is not another token by accident', () => {
    expect(tokens().get('grid')).not.toEqual(tokens().get('line'));
    expect(tokens().get('grid')).not.toEqual(tokens().get('surface-sunken'));
  });
});

// -- Rule: presence has its own family, and the accent stays state ---------

/**
 * Presence colours are the one palette that arrives from another machine — the
 * socket carries a slot index and the client resolves it here. That only keeps
 * colour in one place if the tokens actually exist, are distinct enough to tell
 * three people apart, and are not the accent.
 */
describe('presence colours', () => {
  const SLOTS = 6; // PRESENCE_COLOUR_SLOTS in canvas-core/src/protocol.ts

  it('declares one token per slot the protocol can assign', () => {
    const declared = [...tokens().keys()].filter((name) => name.startsWith('presence-'));
    expect(declared).toHaveLength(SLOTS);
    for (let slot = 0; slot < SLOTS; slot++) {
      expect(tokens().has(`presence-${slot}`)).toBe(true);
    }
  });

  // The accent means "focused, selected, or active — by you". Another person's
  // cursor is none of those, and painting it in the accent would make the rule
  // false everywhere else.
  for (let slot = 0; slot < SLOTS; slot++) {
    it(`presence-${slot} is not the accent`, () => {
      expect(tokens().get(`presence-${slot}`)).not.toEqual(tokens().get('accent'));
    });
  }

  it('keeps every slot distinguishable from every other', () => {
    const seen = new Map<string, number>();
    for (let slot = 0; slot < SLOTS; slot++) {
      const value = JSON.stringify(tokens().get(`presence-${slot}`));
      expect(seen.has(value)).toBe(false);
      seen.set(value, slot);
    }
  });

  // A cursor drawn over the board has to be findable against it.
  for (let slot = 0; slot < SLOTS; slot++) {
    it(`presence-${slot} reads against the canvas ground`, () => {
      expect(contrast(`presence-${slot}`, 'surface-sunken')).toBeGreaterThanOrEqual(3);
    });
  }

  /**
   * A presence colour carries a person's LETTER (agents/board-management's
   * sibling capability, canvas/presence-indicators).
   *
   * Every participant is a tile in the app icon's style: the `surface` ground
   * with their first letter drawn as dots in their colour. A dot-matrix glyph
   * is a graphic and owes 3:1; the bar here is 4.5:1 anyway, because the
   * letter is the only thing on the tile that tells two people apart.
   *
   * If a slot ever fails here, nudge the token rather than the rule.
   */
  for (let slot = 0; slot < SLOTS; slot++) {
    it(`presence-${slot} letter reads on the tile ground`, () => {
      expect(contrast(`presence-${slot}`, 'surface')).toBeGreaterThanOrEqual(4.5);
    });
  }
});
