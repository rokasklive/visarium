/**
 * An app's picture at rest (canvas/apps; openspec canvas-apps-live design §6).
 *
 * A live view sends a snapshot of its page whenever it settles (the kit's
 * `kit.js`). It is cleaned here before it is stored, and again before it is
 * drawn: no scripts, no handlers, nothing loaded from anywhere but `data:`.
 * It is drawn only inside an SVG rasterised as an image, never put into the
 * board's document, so its styles reach nothing else and, whatever cleaning
 * missed, an SVG image runs nothing and fetches nothing.
 */

import { resolvedTheme } from '~/app/theme';

/** The largest card the server keeps, in bytes. */
export const MAX_CARD = 64 * 1024;

const XHTML = 'http://www.w3.org/1999/xhtml';

/** CSS that can only draw: every `url()` but a data image, `image-set()` and `@import` gone. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, 'none')
    .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, 'none');
}

type Purify = typeof import('dompurify').default;
let purifier: Promise<Purify> | undefined;

/** A DOMPurify of its own: its hooks must not reach the notes' Markdown. */
function purify(): Promise<Purify> {
  purifier ??= import('dompurify').then(({ default: create }) => {
    const p = create(window);
    p.addHook('uponSanitizeElement', (node) => {
      if (node.nodeName === 'STYLE' || node.nodeName === 'style')
        node.textContent = cleanCss(node.textContent ?? '');
    });
    p.addHook('uponSanitizeAttribute', (_node, data) => {
      if (data.attrName === 'style') data.attrValue = cleanCss(data.attrValue);
    });
    return p;
  });
  return purifier;
}

/** A snapshot, cleaned: what may be stored and drawn. */
export async function cleanCard(html: string): Promise<string> {
  const p = await purify();
  // Without a DOM it can trust, DOMPurify hands its input back: keep nothing.
  if (!p.isSupported) return '';
  return p.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['foreignObject', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    ALLOWED_URI_REGEXP: /^data:image\//i,
    // A snapshot starts with its <style>, which a fragment would otherwise drop.
    FORCE_BODY: true,
  });
}

/** A stored card with the size of the view it was taken from. */
export function sizedCard(html: string, width: number, height: number): string {
  return `<div data-card-width="${Math.round(width)}" data-card-height="${Math.round(height)}">${html}</div>`;
}

/** Page-level selectors, pointed at the wrappers a card is drawn in. */
function scoped(css: string): string {
  return css
    .replace(/:root\b/g, '.vk-html')
    .replace(/(^|[\s,{}>+~(])html(?=[\s,{.:#[>+~)])/g, '$1.vk-html')
    .replace(/(^|[\s,{}>+~(])body(?=[\s,{.:#[>+~)])/g, '$1.vk-body');
}

/** The board's look, as this person has it, for the kit an app is dressed in. */
export function kitLook(): { theme: 'light' | 'dark'; tokens: Record<string, string> } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--color-${name}`).trim();
  const names: Record<string, string> = {
    surface: 'surface',
    raised: 'surface-raised',
    sunken: 'surface-sunken',
    line: 'line',
    'line-strong': 'line-strong',
    ink: 'ink',
    'ink-dim': 'ink-dim',
    'ink-disabled': 'ink-disabled',
    accent: 'accent',
    'accent-wash': 'accent-wash',
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`series-${n}`, `series-${n}`])),
  };
  return {
    theme: resolvedTheme(),
    tokens: Object.fromEntries(Object.entries(names).map(([k, t]) => [k, token(t)])),
  };
}

let kit: Promise<string> | undefined;

/** The app kit's style sheet, from the board's own origin, once. */
export function kitCss(): Promise<string> {
  kit ??= fetch('/api/apps/kit.css')
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  return kit;
}

/**
 * A card's picture as an SVG `foreignObject` at (`x`, `y`), `width` by
 * `height`: the snapshot, cleaned again, scaled to the width it is drawn at,
 * dressed in the kit with the board's colours as they are now.
 */
export async function cardPicture(
  card: string,
  at: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const [clean, css] = await Promise.all([cleanCard(card), kitCss()]);
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  const sized = doc.body.querySelector<HTMLElement>('[data-card-width]');
  const w = Number(sized?.dataset.cardWidth) || at.width;
  const h = Number(sized?.dataset.cardHeight) || at.height;
  const k = at.width / w;
  const { theme, tokens } = kitLook();
  const vars = Object.entries(tokens)
    .filter(([, v]) => /^[\w .%()/,#-]{1,64}$/.test(v))
    .map(([n, v]) => `--vk-${n}:${v};`)
    .join('');
  // The snapshot's own top element is its <body>: give it the body's rules.
  const top = sized?.querySelector(':scope > div:last-of-type') ?? null;
  top?.classList.add('vk-body');
  for (const s of doc.body.querySelectorAll('style')) s.textContent = scoped(s.textContent ?? '');
  const markup = new XMLSerializer().serializeToString(sized ?? doc.body);
  const style = new XMLSerializer().serializeToString(
    Object.assign(doc.createElement('style'), {
      textContent: `.vk-html{${vars}color-scheme:${theme}}${scoped(css)}`,
    }),
  );
  return `<foreignObject x="${at.x}" y="${at.y}" width="${at.width}" height="${at.height}"><div xmlns="${XHTML}" class="vk-html" style="width:${w}px;height:${Math.min(h, at.height / k)}px;overflow:hidden;transform:scale(${k});transform-origin:0 0">${style}${markup}</div></foreignObject>`;
}
