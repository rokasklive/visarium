/**
 * Links on the board (spec: canvas/links; design D9): where each end is, the
 * line between them, and finding the link under the pointer.
 *
 * All geometry is world units. An anchor is a whole item or one named element
 * inside a diagram; its box is the axis-aligned bounds of that area as the item
 * is placed now (rotated items get the bounds of their rotated box).
 */

import {
  type Anchor,
  type CanvasItem,
  type CanvasItemContent,
  LINK_TYPES,
  type Link,
  type LinkType,
  type Rect,
  type Transform,
  type Vec2,
} from '@visarium/canvas-core';
import { localToWorld, toLayout, worldToLocal } from './interact';
import type { Layout, LocalRect } from './layout';
import { drawnHeight, type ObjectView } from './store';

/** The type a dragged link starts with, from what it is dragged from (spec). */
export function defaultLinkType(source: CanvasItemContent): LinkType {
  if (source.kind === 'checklist') return 'implements';
  if (source.kind === 'diagram') return 'depends-on';
  return 'describes';
}

/** The next type when a selected link's label is clicked. */
export function nextLinkType(t: LinkType): LinkType {
  return LINK_TYPES[(LINK_TYPES.indexOf(t) + 1) % LINK_TYPES.length] as LinkType;
}

/** The smallest named element of a diagram under a layout-unit point. */
export function elementAt(layout: Layout, point: Vec2): string | undefined {
  let best: { name: string; area: number } | undefined;
  for (const [name, r] of layout.elements) {
    const inside =
      point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
    const area = r.width * r.height;
    if (inside && (!best || area < best.area)) best = { name, area };
  }
  return best?.name;
}

/** The anchor at a world point on an item: one of its elements, or the whole item. */
export function anchorAt(item: CanvasItem, view: ObjectView | undefined, world: Vec2): Anchor {
  if (item.content.kind !== 'diagram' || !view) return { itemId: item.id, element: null };
  const local = worldToLocal(item.transform, world);
  return {
    itemId: item.id,
    element: elementAt(view.layout, toLayout(item, view.layout, local)) ?? null,
  };
}

/** Whether a world point is on an item as it is drawn (objects at their drawn height). */
export function contains(item: CanvasItem, view: ObjectView | undefined, world: Vec2): boolean {
  const local = worldToLocal(item.transform, world);
  const h = view ? drawnHeight(item, view.layout) : item.transform.height;
  return local.x >= 0 && local.x <= item.transform.width && local.y >= 0 && local.y <= h;
}

export interface AnchorBox {
  readonly box: Rect;
  /** The anchor names an element its diagram's source no longer declares. */
  readonly broken: boolean;
}

/**
 * Where an anchor is. `t` is the item's transform now: the document's, or the
 * live node's while it is being dragged, so a line follows a moving item.
 */
export function anchorBox(
  item: CanvasItem,
  view: ObjectView | undefined,
  element: string | null | undefined,
  t: Transform,
): AnchorBox {
  const height = view ? drawnHeight(item, view.layout) : t.height;
  const whole: LocalRect = { x: 0, y: 0, width: t.width, height };
  if (!element) return { box: boundsOf(t, whole), broken: false };
  const r = view?.layout.elements.get(element);
  if (!view || !r) {
    // Unknown until laid out; once laid out and absent, broken (spec). Either
    // way the line attaches to the item as a whole.
    return { box: boundsOf(t, whole), broken: view !== undefined };
  }
  const k = t.width / view.layout.width;
  return {
    box: boundsOf(t, { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }),
    broken: false,
  };
}

function boundsOf(t: Transform, r: LocalRect): Rect {
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x, y: r.y + r.height },
    { x: r.x + r.width, y: r.y + r.height },
  ].map((p) => localToWorld(t, p));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

const centre = (r: Rect): Vec2 => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

/** Where the line from the box's centre towards `to` leaves the box, `pad` beyond its edge. */
function edgePoint(r: Rect, to: Vec2, pad: number): Vec2 {
  const c = centre(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const hw = (r.maxX - r.minX) / 2 + pad;
  const hh = (r.maxY - r.minY) / 2 + pad;
  const s = Math.min(Math.abs(hw / (dx || 1e-9)), Math.abs(hh / (dy || 1e-9)));
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export interface Segment {
  readonly from: Vec2;
  readonly to: Vec2;
}

/** Edge to edge, between two anchor boxes, a few screen pixels off each. */
export function segmentBetween(from: Rect, to: Rect, zoom: number): Segment {
  return { from: edgePoint(from, centre(to), 4 / zoom), to: edgePoint(to, centre(from), 6 / zoom) };
}

export function distanceToSegment(p: Vec2, s: Segment): number {
  const dx = s.to.x - s.from.x;
  const dy = s.to.y - s.from.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - s.from.x) * dx + (p.y - s.from.y) * dy) / len2));
  return Math.hypot(p.x - (s.from.x + t * dx), p.y - (s.from.y + t * dy));
}

export const midpoint = (s: Segment): Vec2 => ({
  x: (s.from.x + s.to.x) / 2,
  y: (s.from.y + s.to.y) / 2,
});

/** One link, ready to draw and to hit-test. */
export interface DrawnLink {
  readonly link: Link;
  readonly segment: Segment;
  readonly from: AnchorBox;
  readonly to: AnchorBox;
}

/** The link nearest a world point, within `slop` world units of its line. */
export function linkNear(
  links: readonly DrawnLink[],
  p: Vec2,
  slop: number,
): DrawnLink | undefined {
  let best: { d: DrawnLink; distance: number } | undefined;
  for (const d of links) {
    const distance = distanceToSegment(p, d.segment);
    if (distance <= slop && (!best || distance < best.distance)) best = { d, distance };
  }
  return best?.d;
}

/** The type label's box at a link's midpoint, for a click that cycles it. */
export function labelBox(d: DrawnLink, zoom: number): Rect {
  const m = midpoint(d.segment);
  const w = (d.link.linkType.length * 6.6 + 8) / zoom;
  const h = 16 / zoom;
  return { minX: m.x - w / 2, minY: m.y - h, maxX: m.x + w / 2, maxY: m.y };
}
