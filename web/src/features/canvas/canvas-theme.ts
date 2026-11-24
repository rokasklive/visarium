/**
 * The canvas' colours, read out of the stylesheet once per theme.
 *
 * Konva paints into a bitmap rather than into the DOM, so it cannot resolve
 * `var(--color-item)` the way an element does — the values have to be handed
 * over as strings. `getComputedStyle` forces a style recalculation, and this is
 * called from a surface that re-renders on every pan frame, so the answer is
 * cached.
 *
 * The point of the indirection is that `app.css` stays the only place a colour
 * is chosen. A hex literal in the renderer is a second palette that drifts from
 * the first one silently, which is exactly what this replaced.
 *
 * Cached per theme (appearance/theme): the stylesheet answers for whichever
 * theme `<html data-theme>` holds, so a switch reads the other set once and
 * switching back is free. The surface re-renders on a switch through
 * `useTheme()`, and its next call here returns the new colours.
 */
import { PRESENCE_COLOUR_SLOTS } from '@visarium/canvas-core';
import { resolvedTheme, type Theme } from '~/app/theme';

export interface CanvasTheme {
  /** Fill for an item with no bitmap: placeholder, MICRO lod, still decoding. */
  readonly item: string;
  /** Stroke on an unselected item, and the fill of an aggregate mark. */
  readonly itemEdge: string;
  /** Outline around a group whose members were aggregated away. */
  readonly groupEdge: string;
  /**
   * A group label's text and a framed group's outline stroke.
   *
   * Two roles because they are one annotation system: the label is text and
   * owes 4.5:1 (`ink-dim`), the outline an indicator and owes 3:1
   * (`line-strong`) — both against the canvas ground, both held by
   * tokens.test.ts.
   */
  readonly label: string;
  readonly frame: string;
  /** The ground grid's hairlines. Decorative; held inside its subtle band. */
  readonly grid: string;
  /** The canvas ground itself — the label halo's colour, so text can interrupt a line. */
  readonly ground: string;
  /** A link that is not in focus while something else is (canvas/links): it recedes. */
  readonly linkFaded: string;
  /** Selection, marquee stroke, focus. The only saturated colour chrome draws. */
  readonly accent: string;
  /** The marquee's interior: the accent at 15%. */
  readonly accentWash: string;
  /** Chrome drawn onto the canvas — the transformer's anchors fill with it. */
  readonly surface: string;
  /**
   * One colour per presence slot, indexed by the slot the server assigned.
   *
   * The socket carries an index and this turns it into a colour, which is what
   * keeps `app.css` the only place a colour is chosen even though the value
   * arrives from another machine.
   */
  readonly presence: readonly string[];
}

const cached = new Map<Theme, CanvasTheme>();

export function canvasTheme(): CanvasTheme {
  const theme = resolvedTheme();
  const hit = cached.get(theme);
  if (hit) return hit;

  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => {
    const value = style.getPropertyValue(`--color-${name}`).trim();
    // An empty custom property makes Konva ignore the assignment and keep the
    // previous colour, which looks like a rendering bug three files away. The
    // `@theme static` in app.css is what keeps these emitted; this catches its
    // removal at the first frame instead.
    if (!value) throw new Error(`app.css is missing --color-${name}`);
    return value;
  };

  const read: CanvasTheme = {
    item: token('item'),
    itemEdge: token('item-edge'),
    groupEdge: token('group-edge'),
    label: token('ink-dim'),
    frame: token('line-strong'),
    grid: token('grid'),
    ground: token('surface-sunken'),
    linkFaded: token('link-faded'),
    accent: token('accent'),
    accentWash: token('accent-wash'),
    surface: token('surface'),
    presence: Array.from({ length: PRESENCE_COLOUR_SLOTS }, (_, slot) => token(`presence-${slot}`)),
  };
  cached.set(theme, read);
  return read;
}
