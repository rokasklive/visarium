/**
 * The renderers, loaded on demand (design D3).
 *
 * Each is a dynamic import triggered the first time a board holds that kind,
 * so an image-only board downloads none of them and a board without PlantUML
 * never pays for its engine (about 8.5 MB with its Graphviz layout).
 */

import vizUrl from '@plantuml/core/viz-global.js?url';
import type { Mermaid } from 'mermaid';
import { MONO, SANS } from './style';

/** Which renderers this tab has loaded, for the dev hook and its tests. */
export const loaded = { markdown: 0, mermaid: 0, plantuml: 0 };

type Markdown = { parse(src: string): string; sanitize(html: string): string };

let markdown: Promise<Markdown> | undefined;
export function loadMarkdown(): Promise<Markdown> {
  markdown ??= Promise.all([import('marked'), import('dompurify')]).then(([m, d]) => {
    loaded.markdown += 1;
    const purify = d.default;
    return {
      parse: (src) => m.marked.parse(src, { gfm: true, async: false }) as string,
      // An allow-list, not a deny-list: nothing that fetches (img, media,
      // iframes, svg, style, link) and no attribute that runs or styles.
      sanitize: (html) =>
        purify.sanitize(html, {
          ALLOWED_TAGS: [
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'p',
            'br',
            'hr',
            'blockquote',
            'ul',
            'ol',
            'li',
            'strong',
            'em',
            'del',
            's',
            'code',
            'pre',
            'a',
            'table',
            'thead',
            'tbody',
            'tr',
            'th',
            'td',
            'input',
            'span',
          ],
          ALLOWED_ATTR: ['href', 'type', 'checked', 'disabled', 'start'],
          ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
        }),
    };
  });
  return markdown;
}

export interface MermaidPalette {
  readonly ink: string;
  readonly inkDim: string;
  readonly item: string;
  readonly lineStrong: string;
  readonly surface: string;
}

let mermaid: Promise<Mermaid> | undefined;
export function loadMermaid(palette: MermaidPalette): Promise<Mermaid> {
  mermaid ??= import('mermaid').then(({ default: m }) => {
    loaded.mermaid += 1;
    m.initialize({
      startOnLoad: false,
      // No click callbacks, no scripts, no HTML from the source.
      securityLevel: 'strict',
      // Pure SVG text, which rasterises the same in every engine.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'base',
      fontFamily: SANS,
      themeVariables: {
        darkMode: true,
        fontFamily: SANS,
        fontSize: '14px',
        primaryColor: palette.item,
        primaryBorderColor: palette.lineStrong,
        primaryTextColor: palette.ink,
        secondaryColor: palette.item,
        tertiaryColor: palette.item,
        lineColor: palette.inkDim,
        textColor: palette.ink,
        edgeLabelBackground: palette.surface,
        actorBkg: palette.item,
        actorBorder: palette.lineStrong,
        actorTextColor: palette.ink,
        signalColor: palette.inkDim,
        signalTextColor: palette.ink,
        noteBkgColor: palette.surface,
        noteTextColor: palette.ink,
        noteBorderColor: palette.lineStrong,
        classText: palette.ink,
      },
      themeCSS: `text, tspan { font-family: ${SANS}; } .code, code { font-family: ${MONO}; }`,
    });
    return m;
  });
  return mermaid;
}

type PlantUml = { render(lines: string[], targetId: string, options?: { dark?: boolean }): void };

let plantuml: Promise<PlantUml> | undefined;
export function loadPlantUml(): Promise<PlantUml> {
  plantuml ??= new Promise<void>((resolve, reject) => {
    // Graphviz's layout ships as a classic script that must define its global
    // before the engine starts; as a module it would define nothing.
    const script = document.createElement('script');
    script.src = vizUrl;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('The PlantUML layout engine did not load'));
    document.head.append(script);
  }).then(async () => {
    const engine = (await import('@plantuml/core')) as unknown as PlantUml;
    loaded.plantuml += 1;
    return engine;
  });
  return plantuml;
}
