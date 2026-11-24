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

// -- Two themes -------------------------------------------------------------

// Both themes are held to every rule below. Dark is `@theme static`; light is
// the `:root[data-theme="light"]` block, which overrides it token by token.
const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];
type Oklch = [number, number, number];

const LIGHT_BLOCK = ':root[data-theme="light"] {';

/** The text of one top-level block in app.css, from its opener to its closing brace. */
function block(opener: string): string {
  const css = readFileSync(APP_CSS, 'utf8');
  const start = css.indexOf(opener);
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}', start));
}

/** `--<prefix>-name: oklch(…)` declarations in a block. Alpha is ignored: it composites, it is not a pair. */
function oklchIn(text: string, prefix: string): Map<string, Oklch> {
  const found = new Map<string, Oklch>();
  const re = new RegExp(
    `--${prefix}-([\\w-]+):\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`,
    'g',
  );
  for (const [, name, l, c, h] of text.matchAll(re)) {
    found.set(name as string, [Number(l), Number(c), Number(h)]);
  }
  return found;
}

/** The colour tokens one theme resolves to: dark, plus light's overrides for light. */
function tokens(theme: Theme = 'dark'): Map<string, Oklch> {
  const found = oklchIn(block('@theme static {'), 'color');
  if (theme === 'light') for (const [k, v] of oklchIn(block(LIGHT_BLOCK), 'color')) found.set(k, v);
  return found;
}

/** oklch to linear sRGB, then WCAG relative luminance. Ottosson's matrices. */
function luminance([L, C, h]: Oklch): number {
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

function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(fg: string, bg: string, theme: Theme = 'dark'): number {
  const t = tokens(theme);
  return ratio(luminance(t.get(fg) as Oklch), luminance(t.get(bg) as Oklch));
}

// -- Rule: a token exists in both themes or in neither ---------------------

/**
 * A token added to one theme only renders as the other theme's value in it,
 * which is a bug nobody sees until they switch. Alpha washes are their own
 * values (Konva cannot compose them), so they are held too.
 */
describe('the light theme covers the dark one', () => {
  it('has a light block', () => {
    expect(block(LIGHT_BLOCK)).not.toBe('');
  });

  it('overrides every colour token, and declares none of its own', () => {
    const dark = [...block('@theme static {').matchAll(/--color-([\w-]+):/g)].map((m) => m[1]);
    const light = [...block(LIGHT_BLOCK).matchAll(/--color-([\w-]+):/g)].map((m) => m[1]);
    expect([...light].sort()).toEqual([...dark].sort());
  });
});

// -- Rule: the wordmark's letters read on the chrome they sit on ------------

/** `#rrggbb` to relative luminance, for the wordmark's dark-theme colours. */
function hexLuminance(hex: string): number {
  const ch = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

describe('the wordmark', () => {
  const LETTERS = ['white', 'cream', 'peach', 'coral', 'turquoise'] as const;
  const darkHex = new Map(
    [...readFileSync(APP_CSS, 'utf8').matchAll(/--wordmark-(\w+):\s*(#[0-9a-fA-F]{6})/g)].map(
      (m) => [m[1] as string, m[2] as string],
    ),
  );
  const lightOklch = oklchIn(block(LIGHT_BLOCK), 'wordmark');

  // Its dots are a graphic, so 3:1 (WCAG 1.4.11), on the toolbar and the tiles.
  for (const letter of LETTERS) {
    it(`${letter} reads on dark surface`, () => {
      const hex = darkHex.get(letter) as string;
      expect(
        ratio(hexLuminance(hex), luminance(tokens('dark').get('surface') as Oklch)),
      ).toBeGreaterThanOrEqual(3);
    });
    it(`${letter} reads on light surface`, () => {
      const value = lightOklch.get(letter);
      expect(value, `light block sets --wordmark-${letter}`).toBeDefined();
      expect(
        ratio(luminance(value as Oklch), luminance(tokens('light').get('surface') as Oklch)),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

// -- Rule: chrome holds WCAG 2.2 AA, in both themes --------------------------

for (const theme of THEMES) {
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

  describe(`chrome holds WCAG 2.2 AA (${theme})`, () => {
    it('reads the tokens it is asserting about', () => {
      expect([...tokens(theme).keys()]).toEqual(
        expect.arrayContaining(['ink', 'ink-dim', 'ink-disabled', 'accent', 'line-strong']),
      );
    });

    for (const ink of ['ink', 'ink-dim', 'accent'] as const) {
      for (const ground of CHROME) {
        it(`${ink} on ${ground} clears 4.5:1 for text`, () => {
          expect(contrast(ink, ground, theme)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    // 1.4.11: a border that is the only thing marking a control's boundary.
    for (const ground of FLOATING) {
      it(`line-strong on ${ground} clears 3:1 as a boundary`, () => {
        expect(contrast('line-strong', ground, theme)).toBeGreaterThanOrEqual(3);
      });
    }

    // Inactive controls are exempt from 1.4.3, but exemption is not a licence to
    // be unreadable at 13px. The opacity-40 this replaced computed to 1.96:1.
    for (const ground of FLOATING) {
      it(`ink-disabled on ${ground} stays legible at 3:1`, () => {
        expect(contrast('ink-disabled', ground, theme)).toBeGreaterThanOrEqual(3);
      });
    }

    it('keeps line decorative, so it is never mistaken for a boundary', () => {
      expect(contrast('line', 'surface', theme)).toBeLessThan(3);
    });

    // Two tokens that render the same colour are one token and a bug.
    it('keeps line-strong distinguishable from ink-disabled', () => {
      expect(contrast('line-strong', 'ink-disabled', theme)).not.toBe(1);
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
  describe(`the ground grid (${theme})`, () => {
    it('stays inside its subtle band above the canvas ground', () => {
      const measured = contrast('grid', 'surface-sunken', theme);
      expect(measured).toBeGreaterThanOrEqual(1.3);
      expect(measured).toBeLessThanOrEqual(1.6);
    });

    it('stays quieter than any real boundary on the same ground', () => {
      expect(contrast('grid', 'surface-sunken', theme)).toBeLessThan(
        contrast('line-strong', 'surface-sunken', theme),
      );
    });

    it('is not another token by accident', () => {
      expect(tokens(theme).get('grid')).not.toEqual(tokens(theme).get('line'));
      expect(tokens(theme).get('grid')).not.toEqual(tokens(theme).get('surface-sunken'));
    });
  });

  // -- Rule: presence has its own family, and the accent stays state ---------

  /**
   * Presence colours are the one palette that arrives from another machine — the
   * socket carries a slot index and the client resolves it here. That only keeps
   * colour in one place if the tokens actually exist, are distinct enough to tell
   * three people apart, and are not the accent.
   */
  describe(`presence colours (${theme})`, () => {
    const SLOTS = 6; // PRESENCE_COLOUR_SLOTS in canvas-core/src/protocol.ts

    it('declares one token per slot the protocol can assign', () => {
      const declared = [...tokens(theme).keys()].filter((name) => name.startsWith('presence-'));
      expect(declared).toHaveLength(SLOTS);
      for (let slot = 0; slot < SLOTS; slot++) {
        expect(tokens(theme).has(`presence-${slot}`)).toBe(true);
      }
    });

    // The accent means "focused, selected, or active — by you". Another person's
    // cursor is none of those, and painting it in the accent would make the rule
    // false everywhere else.
    for (let slot = 0; slot < SLOTS; slot++) {
      it(`presence-${slot} is not the accent`, () => {
        expect(tokens(theme).get(`presence-${slot}`)).not.toEqual(tokens(theme).get('accent'));
      });
    }

    it('keeps every slot distinguishable from every other', () => {
      const seen = new Map<string, number>();
      for (let slot = 0; slot < SLOTS; slot++) {
        const value = JSON.stringify(tokens(theme).get(`presence-${slot}`));
        expect(seen.has(value)).toBe(false);
        seen.set(value, slot);
      }
    });

    // A cursor drawn over the board has to be findable against it.
    for (let slot = 0; slot < SLOTS; slot++) {
      it(`presence-${slot} reads against the canvas ground`, () => {
        expect(contrast(`presence-${slot}`, 'surface-sunken', theme)).toBeGreaterThanOrEqual(3);
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
        expect(contrast(`presence-${slot}`, 'surface', theme)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  describe(`link-faded (canvas/links) (${theme})`, () => {
    it('can still be found on the canvas ground', () => {
      expect(contrast('link-faded', 'surface-sunken', theme)).toBeGreaterThan(1.3);
    });
    it('recedes below a link at rest', () => {
      expect(contrast('link-faded', 'surface-sunken', theme)).toBeLessThan(
        contrast('ink-dim', 'surface-sunken', theme) / 2,
      );
    });
  });
}
