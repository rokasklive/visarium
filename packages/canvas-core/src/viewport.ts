/**
 * Turning a camera into a bounded set of things to render.
 *
 * This is the function that makes invariant 8 true: a board may hold 100,000
 * items, but what comes out of here is only what the viewport (plus a preload
 * ring) actually touches, already tagged with the detail level each item
 * deserves.
 *
 *   camera + size ─▶ visible rect ─▶ +preload margin ─▶ spatial query
 *                                                     ─▶ LOD per hit
 *                                                     ─▶ renderer
 */

import { type Camera, type ViewportSize, visibleWorldRect } from './camera';
import type { CanvasDocument } from './document';
import { expandRect, type Rect } from './geometry';
import type { ItemId } from './ids';
import { DEFAULT_LOD_THRESHOLDS, ItemLod, type LodThresholds, resolveLod } from './lod';
import type { CanvasItem } from './model';

export interface VisibleItem {
  readonly item: CanvasItem;
  readonly lod: ItemLod;
}

export interface ActiveSetOptions {
  /**
   * Extra ring around the viewport, as a fraction of viewport size, kept warm so
   * a pan does not reveal blank space. 0.5 preloads half a screen on each side.
   */
  readonly preloadMargin?: number;
  readonly thresholds?: LodThresholds;
  /**
   * Hard ceiling on returned items. Protects the renderer when a user zooms out
   * over a dense region. Exceeding it is the signal to draw aggregates instead
   * of individual items.
   */
  readonly maxItems?: number;
}

export interface ActiveSet {
  readonly visible: readonly VisibleItem[];
  readonly queryRect: Rect;
  /** How many index hits there were before `maxItems` truncation. */
  readonly candidateCount: number;
  /**
   * Ids `maxItems` clipped from {@link visible}.
   *
   * They are returned rather than dropped so the renderer can aggregate them
   * without asking the index the same question a second time — invariant 8 says
   * they must be drawn as something, and a per-frame re-query is how that turns
   * into the slow path.
   */
  readonly overflow: readonly ItemId[];
  /** True when `maxItems` clipped the result: render group aggregates instead. */
  readonly truncated: boolean;
}

export const DEFAULT_PRELOAD_MARGIN = 0.5;
export const DEFAULT_MAX_ITEMS = 2000;

export function computeActiveSet(
  doc: CanvasDocument,
  camera: Camera,
  size: ViewportSize,
  options: ActiveSetOptions = {},
): ActiveSet {
  const {
    preloadMargin = DEFAULT_PRELOAD_MARGIN,
    thresholds = DEFAULT_LOD_THRESHOLDS,
    maxItems = DEFAULT_MAX_ITEMS,
  } = options;

  const view = visibleWorldRect(camera, size);
  const margin = Math.max(view.maxX - view.minX, view.maxY - view.minY) * preloadMargin;
  const queryRect = expandRect(view, margin);

  const candidates = doc.index.search(queryRect);
  const visible: VisibleItem[] = [];
  const overflow: ItemId[] = [];

  for (const id of candidates) {
    if (visible.length >= maxItems) {
      overflow.push(id);
      continue;
    }
    const item = doc.item(id);
    if (!item) continue;
    const lod = resolveLod(item.transform, camera.zoom, thresholds);
    if (lod === ItemLod.HIDDEN) continue;
    visible.push({ item, lod });
  }

  // Painter's order. Renderers rely on this rather than sorting themselves.
  visible.sort((a, b) => a.item.z - b.item.z);

  return {
    visible,
    queryRect,
    candidateCount: candidates.length,
    overflow,
    // Exactly "something was clipped" — candidates alone over-reports, because
    // hidden and unknown ids never occupied a slot.
    truncated: overflow.length > 0,
  };
}

/** Ids under a point, topmost first. Cheap pre-filter for hit testing. */
export function itemsAtPoint(doc: CanvasDocument, worldX: number, worldY: number): ItemId[] {
  const hits = doc.index.search({
    minX: worldX,
    minY: worldY,
    maxX: worldX,
    maxY: worldY,
  });
  return hits.sort((a, b) => (doc.item(b)?.z ?? 0) - (doc.item(a)?.z ?? 0));
}
