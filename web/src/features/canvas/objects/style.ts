/**
 * The one stylesheet a note or checklist renders with: laid out live in an
 * off-screen element, then inlined into the SVG that is rasterised (design D2).
 *
 * Two rules hold for every declaration here, and `style.test.ts` holds them:
 *
 *  - No `position` and no `transform`. WebKit paints positioned layers inside a
 *    scaled `foreignObject` at unscaled coordinates, so at 2x a positioned
 *    checkbox tick lands at half its place and half its size (found by the
 *    rasterisation spike). Decorations are backgrounds instead.
 *  - Colours come from `app.css` tokens, resolved by the caller. A literal
 *    here would be a second palette.
 */

export interface ObjectPalette {
  readonly ink: string;
  readonly inkDim: string;
  readonly accent: string;
  readonly line: string;
  /** The canvas ground: the tick drawn on an accent box. */
  readonly ground: string;
}

export const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** System mono: Departure Mono's lane is group annotations only (ADR-0022). */
export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The checkbox tick, drawn as a background so nothing in the box is positioned. */
function tick(stroke: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.5 6.2 5 8.6 9.6 3.6' fill='none' stroke='${stroke}' stroke-width='2'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function objectCss(p: ObjectPalette): string {
  const wash = `color-mix(in oklab, ${p.line} 60%, transparent)`;
  return `
.vo { font: 15px/1.45 ${SANS}; color: ${p.ink}; overflow-wrap: anywhere; }
.vo > :first-child { margin-top: 0; }
.vo > :last-child { margin-bottom: 0; }
.vo h1, .vo h2, .vo h3, .vo h4, .vo h5, .vo h6 { font-weight: 600; line-height: 1.25; margin: 0 0 6px; }
.vo h1 { font-size: 22px; } .vo h2 { font-size: 19px; } .vo h3 { font-size: 17px; }
.vo h4, .vo h5, .vo h6 { font-size: 15px; }
.vo p { margin: 0 0 8px; }
.vo a { color: ${p.accent}; text-decoration: none; }
.vo strong { font-weight: 600; }
.vo code { font: 13px/1.4 ${MONO}; background: ${wash}; padding: 1px 4px; border-radius: 3px; }
.vo pre { margin: 0 0 8px; padding: 8px 10px; background: ${wash}; border-radius: 6px; white-space: pre-wrap; }
.vo pre code { background: none; padding: 0; }
.vo ul, .vo ol { margin: 0 0 8px; padding-left: 20px; }
.vo li { margin: 2px 0; }
.vo li.vo-task { list-style: none; margin-left: -20px; }
.vo blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid ${p.line}; color: ${p.inkDim}; }
.vo table { border-collapse: collapse; margin: 0 0 8px; }
.vo th, .vo td { border: 1px solid ${p.line}; padding: 3px 6px; text-align: left; }
.vo hr { border: 0; border-top: 1px solid ${p.line}; margin: 8px 0; }
.vo-box { display: inline-block; box-sizing: border-box; width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; border: 1.5px solid ${p.inkDim}; border-radius: 3px; }
.vo-box.on { border-color: ${p.accent}; background: ${p.accent} ${tick(p.ground)} center / 11px 11px no-repeat; }
.vo-title { font-size: 17px; font-weight: 600; line-height: 1.25; margin: 0 0 8px; }
.vo-tasks { list-style: none; padding: 0; margin: 0; }
.vo-tasks li { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 6px; line-height: 1.35; }
.vo-st { flex: none; box-sizing: border-box; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid ${p.inkDim}; margin-top: 1px; }
.vo-st.doing { border-color: ${p.accent}; background: conic-gradient(${p.accent} 0 50%, transparent 0); }
.vo-st.done { border-color: ${p.accent}; background: ${p.accent}; }
.vo-st.blocked { border-style: dashed; background: linear-gradient(135deg, transparent 44%, ${p.inkDim} 44% 56%, transparent 56%); }
.vo-tasks .done .vo-text { text-decoration: line-through; color: ${p.inkDim}; }
.vo-tasks .blocked .vo-text { color: ${p.inkDim}; }
.vo-src { font: 13px/1.45 ${MONO}; white-space: pre-wrap; color: ${p.inkDim}; margin: 0; }
.vo-chip { display: inline-block; font-size: 12px; line-height: 1.3; font-weight: 500; padding: 1px 8px; margin: 0 0 8px; border-radius: 9px; border: 1px solid ${p.line}; color: ${p.inkDim}; }
.vo-chip.accepted { color: ${p.ink}; background: ${wash}; border-color: transparent; font-weight: 600; }
.vo-chip.proposed { border-style: dashed; border-color: ${p.inkDim}; }
.vo-chip.rejected, .vo-chip.superseded { text-decoration: line-through; }
.vo-chip.deprecated { border-style: dotted; }
.vo-chip.question.open { color: ${p.ink}; border: 1.5px solid ${p.ink}; font-weight: 600; }
.vo-chip.answered { border-color: ${p.inkDim}; }
`;
}
