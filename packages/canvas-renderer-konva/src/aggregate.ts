/**
 * Drawing the items that are too small to draw.
 *
 * When an item resolves to AGGREGATE it gets no scene node — but it must still
 * leave a mark, or a zoomed-out board silently renders less than it holds
 * (invariant 8). Every such item is painted here instead, into ONE Konva shape:
 * thousands of `ctx.rect()` calls in a single path cost a fraction of one node
 * each.
 *
 * ponytail: a mark per item, no clustering. If the mark loop itself ever becomes
 * the bottleneck, this is where a real cluster tree would go — the caller's API
 * would not change.
 */

import type { Rect } from '@visarium/canvas-core';

/**
 * The part of Konva's `Context` (and of `CanvasRenderingContext2D`) this uses.
 * Structural, so the paint function stays testable without a real canvas.
 */
export interface AggregateContext {
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  fill(): void;
  stroke(): void;
  set fillStyle(value: string);
  set strokeStyle(value: string);
  set lineWidth(value: number);
}

export interface AggregateStyle {
  /** Fill for individual item marks. */
  readonly itemColor: string;
  /** Stroke for the outline drawn around each group. */
  readonly groupColor: string;
  /** Smallest an item mark may appear, in SCREEN pixels. */
  readonly minScreenSize?: number;
}

/**
 * A mark below this many screen pixels is a mark nobody sees, which defeats the
 * point of drawing one. Colours come from the caller — they are design tokens
 * and belong to the application — but this floor is a rendering concern.
 */
const MIN_SCREEN_SIZE = 2;

export interface AggregateScene {
  /** World bounds of every item being aggregated away. */
  readonly items: readonly Rect[];
  /** World bounds of the groups those items belong to, if any. */
  readonly groups: readonly Rect[];
  /** Current camera zoom: screen sizes are divided by it to reach world units. */
  readonly zoom: number;
}

/**
 * Paint one aggregate frame.
 *
 * Coordinates are world-space; the caller draws inside the layer that already
 * carries the camera's stage transform, so no projection happens here.
 */
export function paintAggregate(
  ctx: AggregateContext,
  scene: AggregateScene,
  style: AggregateStyle,
): void {
  const { items, groups, zoom } = scene;
  const minSize = (style.minScreenSize ?? MIN_SCREEN_SIZE) / zoom;

  if (items.length > 0) {
    ctx.fillStyle = style.itemColor;
    ctx.beginPath();
    for (const r of items) {
      const width = Math.max(r.maxX - r.minX, minSize);
      const height = Math.max(r.maxY - r.minY, minSize);
      ctx.rect(r.minX, r.minY, width, height);
    }
    ctx.fill();
  }

  if (groups.length > 0) {
    ctx.strokeStyle = style.groupColor;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (const r of groups) {
      ctx.rect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    }
    ctx.stroke();
  }
}
