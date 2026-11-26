/**
 * Links on the board (spec: canvas/links; design D9): where each end is, the
 * line between them, and finding the link under the pointer.
 *
 * All geometry is world units. An anchor is a whole item or one named element
 * inside it (a diagram element, a note passage, a checklist task); its box is the axis-aligned bounds of that area as the item
 * is placed now (rotated items get the bounds of their rotated box).
 */

import {
  type Anchor,
  type CanvasItem,
  type CanvasItemContent,
  type ItemId,
  isDataLink,
  type Link,
  type LinkId,
  type LinkType,
  type Rect,
  SEMANTIC_LINK_TYPES,
  type Transform,
  type Vec2,
} from '@visarium/canvas-core';
import { localToWorld, toLayout, worldToLocal } from './interact';
import type { Block, Layout, LocalRect } from './layout';
import { drawnHeight, type ObjectView } from './store';

/** The type a dragged link starts with, from what it is dragged from (spec). */
export function defaultLinkType(source: CanvasItemContent): LinkType {
  if (source.kind === 'checklist') return 'implements';
  if (source.kind === 'diagram') return 'depends-on';
  return 'describes';
}

/**
 * The next type when a selected link's label is clicked: around the semantic
 * types only. A data link keeps its type; its label picks a view instead
 * (canvas/links).
 */
export function nextLinkType(t: LinkType): LinkType {
  if (isDataLink(t)) return t;
  const i = SEMANTIC_LINK_TYPES.indexOf(t);
  return SEMANTIC_LINK_TYPES[(i + 1) % SEMANTIC_LINK_TYPES.length] as LinkType;
}

/**
 * The views each kind offers (canvas/item-views), in the order a `feeds` link
 * cycles them. Kept equal to `server/src/views.rs::offered`, except that an app
 * offers its outputs first: what another app usually reads from it.
 */
const VIEWS: Record<string, readonly string[]> = {
  note: ['text', 'markdown', 'frontmatter', 'tables'],
  diagram: ['text', 'graph'],
  checklist: ['text', 'tasks'],
  image: ['text', 'asset'],
  app: ['outputs', 'text'],
};

export function viewsOf(content: CanvasItemContent): readonly string[] {
  return VIEWS[content.kind] ?? [];
}

/**
 * The data link a drag makes, when it makes one (canvas/links): anything onto
 * an app feeds it its first view; an app onto a checklist may update it.
 */
export function dataLinkFor(
  source: CanvasItem,
  target: CanvasItem,
): { linkType: 'feeds'; view: string } | { linkType: 'updates' } | undefined {
  const view = viewsOf(source.content)[0];
  if (target.content.kind === 'app' && view) return { linkType: 'feeds', view };
  if (source.content.kind === 'app' && target.content.kind === 'checklist')
    return { linkType: 'updates' };
  return undefined;
}

/** The view after this one, for a click on a `feeds` link's label. */
export function nextView(content: CanvasItemContent, view: string): string {
  const views = viewsOf(content);
  return views[(views.indexOf(view) + 1) % views.length] ?? view;
}

/** What a link's label says: its type, and for `feeds` the view it carries. */
export function linkLabel(link: Link): string {
  return link.linkType === 'feeds' && link.view ? `feeds · ${link.view}` : link.linkType;
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
  // A diagram's elements, a note's named passages (canvas/text-anchors), a checklist's tasks.
  const kind = item.content.kind;
  if ((kind !== 'diagram' && kind !== 'note' && kind !== 'checklist') || !view)
    return { itemId: item.id, element: null };
  if (item.content.kind === 'note') {
    // A passage, by name; the note's opening heading is its title, and a link
    // from or to the title is a link to the whole note.
    const block = blockAt(item, view, world);
    return { itemId: item.id, element: block && !isTitle(block) ? (block.name ?? null) : null };
  }
  const local = worldToLocal(item.transform, world);
  return {
    itemId: item.id,
    element: elementAt(view.layout, toLayout(item, view.layout, local)) ?? null,
  };
}

/** A note's opening heading: its title, which stands for the whole note. */
export function isTitle(block: Block): boolean {
  return block.index === 0 && block.heading === true;
}

/** The passage of a note under a world point, named or not (canvas/text-anchors). */
export function blockAt(
  item: CanvasItem,
  view: ObjectView | undefined,
  world: Vec2,
): Block | undefined {
  if (item.content.kind !== 'note' || !view?.layout.blocks) return undefined;
  const p = toLayout(item, view.layout, worldToLocal(item.transform, world));
  return view.layout.blocks.find(
    ({ rect: r }) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height,
  );
}

/** A layout-unit rectangle of an item, as world bounds where the item is now. */
export function layoutBox(t: Transform, view: ObjectView, r: LocalRect): Rect {
  const k = t.width / view.layout.width;
  return boundsOf(t, { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k });
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
  if (!element) {
    // A short note in a wide box: attach to its text, not to empty space.
    const ink = view?.layout.ink;
    if (!ink) return { box: boundsOf(t, whole), broken: false };
    const k = t.width / view.layout.width;
    return {
      box: boundsOf(t, {
        x: ink.x * k,
        y: ink.y * k,
        width: ink.width * k,
        height: ink.height * k,
      }),
      broken: false,
    };
  }
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

/**
 * The two nearest points of two boxes (canvas/link-geometry). Per axis: where
 * the boxes' extents overlap, both ends take the middle of the overlap, so the
 * line runs straight across; otherwise each end takes its own facing edge. A
 * note above a tall sequence-diagram lifeline so lands on the lifeline's head,
 * not partway down it through the drawing.
 */
export function nearestPoints(a: Rect, b: Rect): Segment {
  const axis = (a0: number, a1: number, b0: number, b1: number): [number, number] => {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (lo <= hi) return [(lo + hi) / 2, (lo + hi) / 2];
    return a1 < b0 ? [a1, b0] : [a0, b1];
  };
  const [ax, bx] = axis(a.minX, a.maxX, b.minX, b.maxX);
  const [ay, by] = axis(a.minY, a.maxY, b.minY, b.maxY);
  return { from: { x: ax, y: ay }, to: { x: bx, y: by } };
}

/**
 * Like nearestPoints, but the origin sits at the middle of the source's facing
 * edge: the edge across the gap, or across the wider gap when the boxes are
 * apart on both axes. The target end is unchanged. Overlapping boxes have no
 * facing edge and keep nearestPoints.
 */
export function linkPoints(a: Rect, b: Rect): Segment {
  const s = nearestPoints(a, b);
  const gapX = Math.max(b.minX - a.maxX, a.minX - b.maxX);
  const gapY = Math.max(b.minY - a.maxY, a.minY - b.maxY);
  if (gapX <= 0 && gapY <= 0) return s;
  // s.from already lies on the facing edge; slide it to that edge's middle.
  const from =
    gapY >= gapX
      ? { x: (a.minX + a.maxX) / 2, y: s.from.y }
      : { x: s.from.x, y: (a.minY + a.maxY) / 2 };
  return { from, to: s.to };
}

export interface Segment {
  readonly from: Vec2;
  readonly to: Vec2;
}

/** Nearest point to nearest point, each end a few screen pixels off its box. */
export function segmentBetween(from: Rect, to: Rect, zoom: number): Segment {
  const s = linkPoints(from, to);
  const dx = s.to.x - s.from.x;
  const dy = s.to.y - s.from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return s;
  const off = (pad: number) => Math.min(pad / zoom, len / 3) / len;
  const a = off(4);
  const b = off(6);
  return {
    from: { x: s.from.x + dx * a, y: s.from.y + dy * a },
    to: { x: s.to.x - dx * b, y: s.to.y - dy * b },
  };
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

/**
 * One drawn line, ready to draw and to hit-test: a link, or, at rest, every
 * link from one item to another as one line (`count` > 1, `link` the first).
 */
export interface DrawnLink {
  readonly link: Link;
  readonly segment: Segment;
  readonly from: AnchorBox;
  readonly to: AnchorBox;
  /** How many links this line stands for; 1 for a fanned-out or single link. */
  readonly count: number;
  readonly faded: boolean;
  /** Its type label is shown: it touches what is hovered or selected. */
  readonly labelled: boolean;
}

/** Every link from one item to another, direction kept (canvas/links). */
export interface LinkGroup {
  readonly from: ItemId;
  readonly to: ItemId;
  readonly links: readonly Link[];
}

/**
 * Links grouped by `(from item, to item)`: elements, passages and tasks fold
 * into their item. In the order the first of each group comes.
 */
export function groupLinks(links: Iterable<Link>): LinkGroup[] {
  const groups = new Map<string, { from: ItemId; to: ItemId; links: Link[] }>();
  for (const link of links) {
    const key = `${link.from.itemId}>${link.to.itemId}`;
    const group = groups.get(key);
    if (group) group.links.push(link);
    else groups.set(key, { from: link.from.itemId, to: link.to.itemId, links: [link] });
  }
  return [...groups.values()];
}

/** What is hovered or selected: the items and links that bring links forward. */
export interface LinkFocus {
  readonly items: ReadonlySet<ItemId>;
  readonly links: ReadonlySet<LinkId>;
}

export interface GroupDrawing {
  /** Drawn as its separate links, each to its own anchor; else one line between the items. */
  readonly fanned: boolean;
  /** Its links are labelled: it touches the focus. */
  readonly labelled: boolean;
  readonly strength: 'full' | 'faded' | 'hidden';
}

/**
 * How a group is drawn. At rest a group of more than one is one line; one
 * that touches the focus fans out, labelled, and everything else fades. With
 * links on focus only, what does not touch the focus is not drawn at all.
 */
export function groupDrawing(g: LinkGroup, focus: LinkFocus, onFocusOnly = false): GroupDrawing {
  const touches =
    focus.items.has(g.from) || focus.items.has(g.to) || g.links.some((l) => focus.links.has(l.id));
  const resting = focus.items.size === 0 && focus.links.size === 0;
  return {
    fanned: touches || g.links.length === 1,
    labelled: touches,
    strength: touches ? 'full' : onFocusOnly ? 'hidden' : resting ? 'full' : 'faded',
  };
}

/** How many links each item has, in and out, for the counts shown with links on focus only. */
export function linkCounts(links: Iterable<Link>): Map<ItemId, number> {
  const counts = new Map<ItemId, number>();
  for (const l of links) {
    counts.set(l.from.itemId, (counts.get(l.from.itemId) ?? 0) + 1);
    counts.set(l.to.itemId, (counts.get(l.to.itemId) ?? 0) + 1);
  }
  return counts;
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
  const w = (linkLabel(d.link).length * 6.6 + 8) / zoom;
  const h = 16 / zoom;
  return { minX: m.x - w / 2, minY: m.y - h, maxX: m.x + w / 2, maxY: m.y };
}
