/**
 * An object item laid out for drawing (design D2).
 *
 * One layout pass produces everything the canvas needs to show and to touch a
 * note, checklist or diagram: an SVG it can rasterise at any scale, its natural
 * height at the item's width, the hit regions of the controls inside it, and,
 * for a diagram, the rectangle of every named element (anchors for links).
 * All geometry is item-local, in world units at the item's width.
 *
 * DOM is used only off-screen and only for the length of a layout. Nothing
 * here is drawn by the browser; the canvas draws the bitmap.
 */

import {
  type AppOutput,
  type AppState,
  type CanvasItem,
  type DiagramLang,
  textScaleOf,
} from '@visarium/canvas-core';
import { resolvedTheme, type Theme } from '~/app/theme';
import { measureIn, textIndex } from '../search';
import { cardPicture } from './app-card';
import { slug } from './blocks';
import { loadMarkdown, loadMermaid, loadPlantUml, type MermaidPalette } from './loaders';
import { noteStatus, statusLabel, stripFrontmatter } from './status';
import { APP_BAND, type ObjectPalette, objectCss } from './style';

export interface LocalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A control inside an object: what a click there means. */
export type Hit =
  | { readonly kind: 'checkbox'; readonly index: number }
  | { readonly kind: 'link'; readonly href: string }
  | { readonly kind: 'task-state'; readonly taskId: string }
  | { readonly kind: 'task-text'; readonly taskId: string }
  | { readonly kind: 'title' }
  /** A note's status chip (canvas/note-status): a control unless read-only. */
  | { readonly kind: 'status' };

export interface Layout {
  /** Width and height in world units, at the item's width. */
  readonly width: number;
  readonly height: number;
  /** The drawing as an SVG document sized for `scale` device pixels per unit. */
  svg(scale: number): string;
  readonly hits: readonly (Hit & { readonly rect: LocalRect })[];
  readonly elements: ReadonlyMap<string, LocalRect>;
  /**
   * The box around what is actually drawn — text and task marks, not the empty
   * width beside a short line. Where a line to the whole item attaches.
   */
  readonly ink?: LocalRect | undefined;
  /** A note's passages in reading order, named or not (canvas/text-anchors). */
  readonly blocks?: readonly Block[];
  /** The drawn text, passages separated by `\n` (canvas/quick-search). */
  readonly text: string;
  /**
   * Where each occurrence of `query` is drawn, item-local, several rects for
   * one that wraps. Mounts the markup off-screen again for the length of the
   * call, so it is for the few items a search matches, not for every frame.
   */
  measure(query: string): LocalRect[][];
}

export interface Block {
  /** Its place in reading order: the same as `sourceBlocks`. */
  readonly index: number;
  readonly name?: string;
  readonly rect: LocalRect;
  /** Its drawn text, to check the source block is the same one. */
  readonly text: string;
  readonly heading?: boolean;
}

/** A diagram whose source does not parse. The caller keeps the last good layout. */
export class SourceError extends Error {}

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

let host: HTMLDivElement | undefined;
/** Where layouts happen: in the document (layout needs it), out of sight. */
function offscreen(): HTMLDivElement {
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
  document.body.append(host);
  return host;
}

const colours = new Map<Theme, { object: ObjectPalette; mermaid: MermaidPalette }>();
/**
 * The palette, from `app.css`. Object CSS uses the tokens as written; Mermaid's
 * colour maths only reads hex, so its colours are resolved by painting one
 * pixel and reading it back. Cached per theme (see canvas-theme.ts); a switch
 * re-lays out every object because the theme is part of its layout key.
 */
function palette() {
  const theme = resolvedTheme();
  const hit = colours.get(theme);
  if (hit) return hit;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--color-${name}`).trim();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const resolved = (name: string) => {
    if (!ctx) return token(name);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = token(name);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
  };
  const read = {
    object: {
      ink: token('ink'),
      inkDim: token('ink-dim'),
      accent: token('accent'),
      line: token('line'),
      ground: token('surface-sunken'),
      surface: token('surface'),
      raised: token('surface-raised'),
      itemEdge: token('item-edge'),
    },
    mermaid: {
      ink: resolved('ink'),
      inkDim: resolved('ink-dim'),
      item: resolved('item'),
      lineStrong: resolved('line-strong'),
      surface: resolved('surface'),
    },
  };
  colours.set(theme, read);
  return read;
}

export async function layoutItem(item: CanvasItem, appState?: AppState): Promise<Layout> {
  const width = laidWidth(item);
  const c = item.content;
  switch (c.kind) {
    case 'note':
      return layoutNote(c.source, width);
    case 'checklist':
      return layoutHtml(checklistHtml(c.title, c.tasks), width);
    case 'diagram':
      return layoutDiagram(c.lang, c.source, width);
    case 'app': {
      // The card fills the app's box: the box is the frame its view mounts in.
      const height = item.transform.height;
      const picture = c.output?.card
        ? await cardPicture(c.output.card, {
            x: 1,
            y: APP_BAND + 1,
            width: width - 2,
            height: height - APP_BAND - 2,
          }).catch(() => undefined)
        : undefined;
      const card = await layoutHtml(
        appCardHtml(c.title, c.output, appState, picture !== undefined),
        width,
        (root) => {
          root.style.height = `${height}px`;
          root.style.boxSizing = 'border-box';
        },
      );
      // Its frame is what is drawn, so links meet the frame, not its text.
      // The app's own picture goes over the empty body, inside the same image.
      const svg = picture
        ? (scale: number) => card.svg(scale).replace(/<\/svg>$/, `${picture}</svg>`)
        : card.svg;
      return { ...card, svg, ink: undefined };
    }
    default:
      throw new Error(`no layout for ${c.kind}`);
  }
}

/** How a state reads on the card, and its class. */
export function appStateLabel(s: AppState | undefined): { text: string; cls: string } {
  switch (s?.state) {
    case undefined:
    case 'never run':
      return { text: 'never run', cls: 'never' };
    case 'fresh':
      return { text: 'fresh', cls: 'fresh' };
    case 'stale':
      return {
        text: `stale · ${s.moved.length} input${s.moved.length === 1 ? '' : 's'} changed`,
        cls: 'stale',
      };
    case 'error':
      return { text: 'error', cls: 'error' };
    case 'upstream stale':
      return { text: 'upstream stale', cls: 'upstream-stale' };
    case 'upstream error':
      return { text: 'upstream error', cls: 'upstream-error' };
  }
}

const MAX_SHOWN = 6;

/** An app's host band: what it is, its title, and where it stands (canvas/apps). */
export function appBandHtml(title: string, state?: AppState): string {
  const label = appStateLabel(state);
  return `<div class="vo-app-band"><span>App</span><div class="vo-title">${escapeHtml(title || 'App')}</div><span class="vo-app-state ${label.cls}"><span class="vo-app-lamp"></span><span class="vo-app-word">${escapeHtml(label.text)}</span></span></div>`;
}

/** An app at rest (canvas/apps): its band, then its latest outputs. No app code runs. */
export function appCardHtml(
  title: string,
  output: AppOutput | undefined,
  state?: AppState,
  /** Its body is the app's own picture, drawn over it: leave it empty. */
  pictured = false,
): string {
  if (pictured)
    return `<div class="vo-app">${appBandHtml(title, state)}<div class="vo-app-body"></div></div>`;
  const entries = Object.entries(output?.outputs ?? {});
  const short = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > 60 ? `${t.slice(0, 59)}…` : t;
  };
  const rows = entries
    .slice(0, MAX_SHOWN)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(short(v))}</dd>`)
    .join('');
  const more =
    entries.length > MAX_SHOWN ? `<dt></dt><dd>+${entries.length - MAX_SHOWN} more</dd>` : '';
  const out = rows ? `<dl class="vo-app-out">${rows}${more}</dl>` : '';
  const error =
    state?.state === 'error' && state.error
      ? `<p class="vo-app-note">${escapeHtml(state.error)}</p>`
      : '';
  const hint = output ? '' : '<p class="vo-app-hint">Double-click to open and run it.</p>';
  return `<div class="vo-app">${appBandHtml(title, state)}<div class="vo-app-body">${out}${error}${hint}</div></div>`;
}

/**
 * The width an object is laid out at. A note or checklist with a text scale is
 * laid out at its width divided by the scale and drawn at its width, so its text
 * is that much larger with the same line breaks (canvas/text-scaling). A
 * diagram already scales with its box.
 */
export function laidWidth(item: CanvasItem): number {
  const scaled = item.content.kind === 'note' || item.content.kind === 'checklist';
  return Math.max(1, item.transform.width / (scaled ? textScaleOf(item) : 1));
}

/** A diagram that has never rendered shows its source, so nothing is invisible. */
export function layoutSource(source: string, width: number): Promise<Layout> {
  return layoutHtml(`<pre class="vo-src">${escapeHtml(source)}</pre>`, width);
}

async function layoutNote(source: string, width: number): Promise<Layout> {
  const md = await loadMarkdown();
  return layoutHtml(noteMarkup(md, source), width, prepareNote);
}

/**
 * A note's markup: frontmatter is not drawn, and a status chip sits above the
 * first block (canvas/note-status). The chip is a `div`, so it is never a
 * passage.
 */
function noteMarkup(md: { parse(s: string): string; sanitize(h: string): string }, source: string) {
  const status = noteStatus(source);
  const chip = status
    ? `<div class="vo-chip ${status.kind}${status.state ? ` ${status.state}` : ''}" data-status="">${escapeHtml(statusLabel(status))}</div>`
    : '';
  return chip + md.sanitize(md.parse(stripFrontmatter(source)));
}

/**
 * A note's drawn markup without laying it out: what search reads for a note
 * that is not on screen, so its text is the same as once it is drawn.
 */
export function noteHtml(md: { parse(s: string): string; sanitize(h: string): string }) {
  return (source: string): string => {
    const root = document.createElement('div');
    root.innerHTML = noteMarkup(md, source);
    prepareNote(root);
    return root.innerHTML;
  };
}

function prepareNote(root: HTMLElement): void {
  // Task checkboxes become drawn boxes: a native input rasterises in the
  // platform's grey, and a span takes the palette and becomes a hit region.
  // Matched as plain `input`: marked only emits inputs for task items, and
  // the browser build of DOMPurify drops their `type` attribute.
  root.querySelectorAll('input').forEach((input, index) => {
    const box = document.createElement('span');
    box.className = `vo-box${input.hasAttribute('checked') ? ' on' : ''}`;
    box.dataset.box = String(index);
    input.closest('li')?.classList.add('vo-task');
    input.replaceWith(box);
  });
  nameBlocks(root);
}

/**
 * Tag every block of a rendered note (canvas/text-anchors), in reading order:
 * `data-block-index` for each, `data-block` with its name for a named one. A
 * paragraph's or list item's ` ^id` is taken out of the drawing; a heading is
 * named by its slug. Mirrors `sourceBlocks`, which reads the same from source.
 */
function nameBlocks(root: HTMLElement): void {
  const slugs = new Map<string, number>();
  const blocks = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, li, p');
  let index = 0;
  for (const el of blocks) {
    // A loose list item's paragraphs are the item; a quote's are paragraphs.
    if (el.tagName === 'P' && el.parentElement?.closest('li')) continue;
    el.dataset.blockIndex = String(index++);
    const own = ownTextNodes(el);
    const last = own.at(-1);
    const marker = last && /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/.exec(last.data);
    if (last && marker) {
      last.data = last.data.slice(0, marker.index);
      el.dataset.block = `^${marker[1]}`;
      continue;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      let name = slug(el.textContent ?? '');
      const seen = slugs.get(name) ?? 0;
      slugs.set(name, seen + 1);
      if (seen > 0) name = `${name}-${seen}`;
      if (name) el.dataset.block = name;
    }
  }
}

/** A block's own text, not that of the lists or paragraphs nested in it. */
function ownTextNodes(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
      else if (child instanceof HTMLElement && !/^(UL|OL|P)$/.test(child.tagName)) walk(child);
      else if (child instanceof HTMLElement && child.tagName === 'P' && el.tagName === 'LI')
        walk(child);
    }
  };
  walk(el);
  return out.filter((t) => t.data.trim() !== '');
}

export function checklistHtml(
  title: string,
  tasks: readonly { id: string; text: string; state: string }[],
): string {
  const head = title ? `<div class="vo-title" data-title="">${escapeHtml(title)}</div>` : '';
  const rows = tasks
    .map(
      (t) =>
        `<li class="${escapeHtml(t.state)}" data-task="${escapeHtml(t.id)}"><span class="vo-st ${escapeHtml(t.state)}"></span><span class="vo-text">${escapeHtml(t.text)}</span></li>`,
    )
    .join('');
  return `${head}<ul class="vo-tasks">${rows}</ul>`;
}

/**
 * Lay out HTML at `width` off-screen, read its height and control rectangles,
 * and wrap the same markup, with the same CSS, in an SVG `foreignObject`.
 */
async function layoutHtml(
  html: string,
  width: number,
  prepare?: (root: HTMLElement) => void,
): Promise<Layout> {
  const css = objectCss(palette().object);
  const root = document.createElement('div');
  root.className = 'vo';
  root.style.width = `${width}px`;
  root.innerHTML = html;
  prepare?.(root);
  const style = document.createElement('style');
  style.textContent = css;
  const frame = document.createElement('div');
  frame.append(style, root);
  offscreen().append(frame);
  try {
    const origin = root.getBoundingClientRect();
    const height = Math.max(1, Math.ceil(origin.height));
    const local = (el: Element): LocalRect => {
      const r = el.getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
    };
    const hits: (Hit & { rect: LocalRect })[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('[data-box]')) {
      hits.push({ kind: 'checkbox', index: Number(el.dataset.box), rect: local(el) });
    }
    for (const el of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      hits.push({ kind: 'link', href: el.getAttribute('href') ?? '', rect: local(el) });
    }
    root.querySelectorAll<HTMLElement>('[data-task]').forEach((li) => {
      const taskId = li.dataset.task ?? '';
      const state = li.querySelector('.vo-st');
      const text = li.querySelector('.vo-text');
      if (state) hits.push({ kind: 'task-state', taskId, rect: local(state) });
      if (text) hits.push({ kind: 'task-text', taskId, rect: local(text) });
    });
    const title = root.querySelector('[data-title]');
    if (title) hits.push({ kind: 'title', rect: local(title) });
    const chip = root.querySelector('[data-status]');
    if (chip) hits.push({ kind: 'status', rect: local(chip) });
    // A checklist's tasks are link anchors by id (`t3`), like a diagram's elements.
    const elements = new Map<string, LocalRect>();
    for (const li of root.querySelectorAll<HTMLElement>('[data-task]')) {
      if (li.dataset.task) elements.set(li.dataset.task, local(li));
    }
    // A note's passages: named ones are link anchors, like a diagram's
    // elements; every one is a place a link can start from (canvas/text-anchors).
    const blocks: Block[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('[data-block-index]')) {
      const rect = local(el);
      if (el.dataset.block && !elements.has(el.dataset.block)) elements.set(el.dataset.block, rect);
      blocks.push({
        index: Number(el.dataset.blockIndex),
        rect,
        text: el.textContent ?? '',
        ...(el.dataset.block ? { name: el.dataset.block } : {}),
        ...(/^H[1-6]$/.test(el.tagName) ? { heading: true } : {}),
      });
    }

    const text = textIndex(root).text;
    const markup = new XMLSerializer().serializeToString(root);
    const body = `<foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="${XHTML}"><style>${escapeXml(css)}</style>${markup}</div></foreignObject>`;
    return {
      width,
      height,
      hits,
      elements,
      blocks,
      ink: inkOf(root, origin),
      text,
      measure: (query) => {
        const again = document.createElement('div');
        const sheet = document.createElement('style');
        sheet.textContent = css;
        again.append(sheet);
        again.insertAdjacentHTML('beforeend', markup);
        offscreen().append(again);
        try {
          const laid = again.lastElementChild as HTMLElement;
          return measureIn(laid, laid.getBoundingClientRect(), query);
        } finally {
          again.remove();
        }
      },
      svg: (scale) =>
        `<svg xmlns="${SVG}" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
    };
  } finally {
    frame.remove();
  }
}

/** The union of every text line box and task mark under `root`, item-local. */
function inkOf(root: HTMLElement, origin: DOMRect): LocalRect | undefined {
  const rects: DOMRect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n as Text).data.trim()) continue;
    range.selectNodeContents(n);
    rects.push(...range.getClientRects());
  }
  for (const el of root.querySelectorAll('[data-box], .vo-st, img, hr')) {
    rects.push(el.getBoundingClientRect());
  }
  const drawn = rects.filter((r) => r.width > 0 && r.height > 0);
  if (drawn.length === 0) return undefined;
  const left = Math.min(...drawn.map((r) => r.left));
  const top = Math.min(...drawn.map((r) => r.top));
  const right = Math.max(...drawn.map((r) => r.right));
  const bottom = Math.max(...drawn.map((r) => r.bottom));
  return { x: left - origin.left, y: top - origin.top, width: right - left, height: bottom - top };
}

let renderSeq = 0;

async function layoutDiagram(lang: DiagramLang, source: string, width: number): Promise<Layout> {
  const raw = lang === 'mermaid' ? await mermaidSvg(source) : await plantUmlSvg(source);
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg' || doc.querySelector('parsererror'))
    throw new Error('the renderer returned no SVG');

  // The drawing's own coordinate box decides its proportions; the item's width
  // decides its size. Height follows (spec: canvas/diagrams).
  const [, , vbW = 0, vbH = 0] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const natural = {
    w: vbW || Number.parseFloat(svg.getAttribute('width') ?? '') || width,
    h: vbH || Number.parseFloat(svg.getAttribute('height') ?? '') || 1,
  };
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${natural.w} ${natural.h}`);
  const height = Math.max(1, Math.round((width * natural.h) / natural.w));
  // Only the marks paint: no background, no max-width from the renderer.
  svg.removeAttribute('style');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  // Element rectangles need real layout: mount the drawing at its final size.
  const live = document.importNode(svg, true) as unknown as SVGSVGElement;
  offscreen().append(live);
  const elements = new Map<string, LocalRect>();
  let text = '';
  try {
    const origin = live.getBoundingClientRect();
    text = textIndex(live).text;
    for (const [name, els] of elementsOf(live, lang)) {
      // An element drawn in parts (a sequence participant's head, lifeline and
      // foot) is the box around all of them.
      const rs = els.map((el) => el.getBoundingClientRect());
      const left = Math.min(...rs.map((r) => r.left));
      const top = Math.min(...rs.map((r) => r.top));
      const right = Math.max(...rs.map((r) => r.right));
      const bottom = Math.max(...rs.map((r) => r.bottom));
      elements.set(name, {
        x: left - origin.left,
        y: top - origin.top,
        width: right - left,
        height: bottom - top,
      });
    }
  } finally {
    live.remove();
  }

  const serialised = new XMLSerializer().serializeToString(svg);
  return {
    width,
    height,
    hits: [],
    elements,
    text,
    measure: (query) => {
      const parsed = new DOMParser().parseFromString(serialised, 'image/svg+xml').documentElement;
      const again = document.importNode(parsed, true) as unknown as SVGSVGElement;
      offscreen().append(again);
      try {
        return measureIn(again, again.getBoundingClientRect(), query);
      } finally {
        again.remove();
      }
    },
    svg: (scale) =>
      serialised.replace(
        /^<svg([^>]*?)\swidth="[^"]*"([^>]*?)\sheight="[^"]*"/,
        `<svg$1 width="${width * scale}"$2 height="${height * scale}"`,
      ),
  };
}

async function mermaidSvg(source: string): Promise<string> {
  const mermaid = await loadMermaid(palette().mermaid, resolvedTheme() === 'dark');
  const id = `vo-mmd-${++renderSeq}`;
  try {
    await mermaid.parse(source);
  } catch (e) {
    throw new SourceError(String((e as Error)?.message ?? e));
  }
  try {
    return (await mermaid.render(id, source)).svg;
  } catch (e) {
    throw new SourceError(String((e as Error)?.message ?? e));
  } finally {
    // A failed render can leave its scratch element behind.
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * Visarium's palette as a PlantUML style block (canvas/diagrams).
 *
 * PlantUML otherwise draws with its own skins: neutral grays in dark, but
 * lavender participants and yellow notes in light. The hex values are the
 * same ones Mermaid gets, so both languages draw one palette per theme.
 */
export function plantUmlStyle(p: MermaidPalette): string[] {
  return [
    '<style>',
    `root { FontColor ${p.ink}; LineColor ${p.lineStrong}; BackGroundColor ${p.item} }`,
    'document { BackGroundColor transparent }',
    `arrow { LineColor ${p.inkDim}; FontColor ${p.ink} }`,
    `note { BackGroundColor ${p.surface}; LineColor ${p.lineStrong} }`,
    `lifeLine { LineColor ${p.inkDim} }`,
    `group { BackGroundColor transparent }`,
    '</style>',
  ];
}

/**
 * The source with the palette's style block just after its `@start…` line.
 * Before the person's own lines, so a `<style>` or `skinparam` of theirs still
 * wins; a source with no start line is left alone for PlantUML to refuse.
 */
export function withPlantUmlStyle(lines: string[], p: MermaidPalette): string[] {
  const start = lines.findIndex((l) => /^\s*@start\w+/i.test(l));
  if (start < 0) return lines;
  return [...lines.slice(0, start + 1), ...plantUmlStyle(p), ...lines.slice(start + 1)];
}

/** The engine keeps shared state between renders, so they run one at a time. */
let plantUmlQueue: Promise<unknown> = Promise.resolve();

function plantUmlSvg(source: string): Promise<string> {
  const run = plantUmlQueue.then(async () => {
    const engine = await loadPlantUml();
    const target = document.createElement('div');
    target.id = `vo-puml-${++renderSeq}`;
    offscreen().append(target);
    try {
      const svg = await new Promise<string>((resolve, reject) => {
        const done = (fn: () => void) => {
          observer.disconnect();
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(
          () => done(() => reject(new Error('PlantUML took over 20 s'))),
          20_000,
        );
        const observer = new MutationObserver(() => {
          const out = target.querySelector('svg');
          if (out) done(() => resolve(out.outerHTML));
        });
        observer.observe(target, { childList: true, subtree: true });
        try {
          engine.render(
            withPlantUmlStyle(source.split(/\r\n|\r|\n/), palette().mermaid),
            target.id,
            {
              dark: resolvedTheme() === 'dark',
            },
          );
        } catch (e) {
          done(() => reject(e));
        }
      });
      // PlantUML draws its own error picture rather than throwing; that is a
      // source that does not parse, so the last good drawing stays (spec).
      if (/Syntax Error\?|Some diagram description contains errors/.test(svg)) {
        throw new SourceError('PlantUML could not read this source');
      }
      return await sanitizeSvg(svg);
    } finally {
      target.remove();
    }
  });
  plantUmlQueue = run.catch(() => {});
  return run;
}

async function sanitizeSvg(svg: string): Promise<string> {
  const { default: purify } = await import('dompurify');
  return purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

/**
 * The named elements of a rendered diagram, by the name its SOURCE gives them
 * (design D4): Mermaid node ids, PlantUML participant, class and entity names.
 * Never by label or drawing order, so renaming an element breaks its anchors.
 *
 * Mermaid's DOM ids are not a public API; `objects.spec.ts` pins what this
 * reads against the installed Mermaid and PlantUML versions.
 */
export function elementsOf(svg: Element, lang: DiagramLang): Map<string, Element[]> {
  const found = new Map<string, Element[]>();
  const add = (name: string | null | undefined, el: Element) => {
    if (name && !found.has(name)) found.set(name, [el]);
  };
  /** Another part of an element already found. */
  const extend = (name: string | null | undefined, el: Element) => {
    if (name) found.get(name)?.push(el);
  };
  if (lang === 'plantuml') {
    for (const el of svg.querySelectorAll(
      '[data-qualified-name], [data-participant], [data-entity]',
    )) {
      add(
        el.getAttribute('data-participant') ??
          el.getAttribute('data-qualified-name') ??
          el.getAttribute('data-entity'),
        el,
      );
    }
    return found;
  }
  // Mermaid 12 prefixes element ids with the render's own id, so the kind
  // marker is matched anywhere: `<render>-flowchart-Pay-1`, `<render>-classId-Board-0`.
  svg.querySelectorAll('g.node, g[id*="classId-"], g[id*="state-"]').forEach((el) => {
    const id = el.getAttribute('id') ?? '';
    add(
      el.getAttribute('data-id') ??
        /(?:^|-)flowchart-(.+)-\d+$/.exec(id)?.[1] ??
        /(?:^|-)classId-(.+)-\d+$/.exec(id)?.[1] ??
        /(?:^|-)state-(.+)-\d+$/.exec(id)?.[1],
      el,
    );
  });
  // A sequence participant is its head box, its lifeline and its foot box, as
  // PlantUML's participant group is (canvas/link-geometry): the whole column
  // highlights, and a link lands on its nearest point.
  for (const el of svg.querySelectorAll('rect.actor-top[name]')) add(el.getAttribute('name'), el);
  for (const el of svg.querySelectorAll('rect.actor[name]')) add(el.getAttribute('name'), el);
  for (const el of svg.querySelectorAll('line.actor-line[name], rect.actor-bottom[name]'))
    extend(el.getAttribute('name'), el);
  return found;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string);
}
