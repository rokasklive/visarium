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

import type { CanvasItem, DiagramLang } from '@visarium/canvas-core';
import { loadMarkdown, loadMermaid, loadPlantUml, type MermaidPalette } from './loaders';
import { type ObjectPalette, objectCss } from './style';

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
  | { readonly kind: 'title' };

export interface Layout {
  /** Width and height in world units, at the item's width. */
  readonly width: number;
  readonly height: number;
  /** The drawing as an SVG document sized for `scale` device pixels per unit. */
  svg(scale: number): string;
  readonly hits: readonly (Hit & { readonly rect: LocalRect })[];
  readonly elements: ReadonlyMap<string, LocalRect>;
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

let colours: { object: ObjectPalette; mermaid: MermaidPalette } | undefined;
/**
 * The palette, from `app.css`. Object CSS uses the tokens as written; Mermaid's
 * colour maths only reads hex, so its colours are resolved by painting one
 * pixel and reading it back. Cached: there is one theme (see canvas-theme.ts).
 */
function palette() {
  if (colours) return colours;
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
  colours = {
    object: {
      ink: token('ink'),
      inkDim: token('ink-dim'),
      accent: token('accent'),
      line: token('line'),
      ground: token('surface-sunken'),
    },
    mermaid: {
      ink: resolved('ink'),
      inkDim: resolved('ink-dim'),
      item: resolved('item'),
      lineStrong: resolved('line-strong'),
      surface: resolved('surface'),
    },
  };
  return colours;
}

export async function layoutItem(item: CanvasItem): Promise<Layout> {
  const width = Math.max(1, item.transform.width);
  const c = item.content;
  switch (c.kind) {
    case 'note':
      return layoutNote(c.source, width);
    case 'checklist':
      return layoutHtml(checklistHtml(c.title, c.tasks), width);
    case 'diagram':
      return layoutDiagram(c.lang, c.source, width);
    default:
      throw new Error(`no layout for ${c.kind}`);
  }
}

/** A diagram that has never rendered shows its source, so nothing is invisible. */
export function layoutSource(source: string, width: number): Promise<Layout> {
  return layoutHtml(`<pre class="vo-src">${escapeHtml(source)}</pre>`, width);
}

async function layoutNote(source: string, width: number): Promise<Layout> {
  const md = await loadMarkdown();
  return layoutHtml(md.sanitize(md.parse(source)), width, (root) => {
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
  });
}

function checklistHtml(
  title: string,
  tasks: readonly { id: string; text: string; state: string }[],
): string {
  const head = title ? `<div class="vo-title" data-title="">${escapeHtml(title)}</div>` : '';
  const rows = tasks
    .map(
      (t) =>
        `<li class="${t.state}" data-task="${escapeHtml(t.id)}"><span class="vo-st ${t.state}"></span><span class="vo-text">${escapeHtml(t.text)}</span></li>`,
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

    const markup = new XMLSerializer().serializeToString(root);
    const body = `<foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="${XHTML}"><style>${escapeXml(css)}</style>${markup}</div></foreignObject>`;
    return {
      width,
      height,
      hits,
      elements: new Map(),
      svg: (scale) =>
        `<svg xmlns="${SVG}" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
    };
  } finally {
    frame.remove();
  }
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
  try {
    const origin = live.getBoundingClientRect();
    for (const [name, el] of elementsOf(live, lang)) {
      const r = el.getBoundingClientRect();
      elements.set(name, {
        x: r.left - origin.left,
        y: r.top - origin.top,
        width: r.width,
        height: r.height,
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
    svg: (scale) =>
      serialised.replace(
        /^<svg([^>]*?)\swidth="[^"]*"([^>]*?)\sheight="[^"]*"/,
        `<svg$1 width="${width * scale}"$2 height="${height * scale}"`,
      ),
  };
}

async function mermaidSvg(source: string): Promise<string> {
  const mermaid = await loadMermaid(palette().mermaid);
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
          engine.render(source.split(/\r\n|\r|\n/), target.id, { dark: true });
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
export function elementsOf(svg: Element, lang: DiagramLang): Map<string, Element> {
  const found = new Map<string, Element>();
  const add = (name: string | null | undefined, el: Element) => {
    if (name && !found.has(name)) found.set(name, el);
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
  // Sequence diagrams draw each participant twice; the anchor is the top box.
  for (const el of svg.querySelectorAll('rect.actor-top[name]')) add(el.getAttribute('name'), el);
  for (const el of svg.querySelectorAll('rect.actor[name]')) add(el.getAttribute('name'), el);
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
