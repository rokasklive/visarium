/**
 * Selection.
 *
 * Selection is a set of item ids and nothing more — it holds no geometry, so it
 * cannot go stale when items move. Bounds are derived on demand.
 *
 * It lives in canvas-core rather than in UI state because marquee selection is a
 * spatial query, and spatial queries belong next to the index.
 */

import type { CanvasDocument } from './document';
import {
  type FlipAxis,
  type Rect,
  rectCentre,
  reflectTransform,
  transformIntersectsRect,
  unionRects,
} from './geometry';
import type { GroupId, ItemId } from './ids';
import type { CanvasOperationBody } from './operations';

export type SelectionMode = 'replace' | 'add' | 'toggle';

export function applySelection(
  current: ReadonlySet<ItemId>,
  ids: Iterable<ItemId>,
  mode: SelectionMode,
): Set<ItemId> {
  if (mode === 'replace') return new Set(ids);
  const next = new Set(current);
  for (const id of ids) {
    if (mode === 'toggle' && next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

export interface MarqueeOptions {
  /** `true` selects only fully-enclosed items; `false` selects anything touched. */
  readonly requireContainment?: boolean;
}

/**
 * Items hit by a marquee rect.
 *
 * The index answers with AABB candidates; each is then re-tested against its
 * true rotated shape, because a rotated item's AABB overlapping the marquee does
 * not mean the item does.
 */
export function marqueeSelect(
  doc: CanvasDocument,
  area: Rect,
  options: MarqueeOptions = {},
): ItemId[] {
  const { requireContainment = false } = options;
  const hits: ItemId[] = [];
  for (const id of doc.index.search(area)) {
    const item = doc.item(id);
    if (!item) continue;
    if (requireContainment) {
      const bounds = doc.index.boundsOf(id);
      if (!bounds) continue;
      const contained =
        area.minX <= bounds.minX &&
        area.minY <= bounds.minY &&
        area.maxX >= bounds.maxX &&
        area.maxY >= bounds.maxY;
      if (!contained) continue;
    } else if (!transformIntersectsRect(item.transform, area)) {
      continue;
    }
    hits.push(id);
  }
  return hits;
}

/** Expand a selection so that selecting one grouped item selects its whole group. */
export function expandToGroups(doc: CanvasDocument, ids: Iterable<ItemId>): Set<ItemId> {
  const out = new Set<ItemId>();
  const seenGroups = new Set<GroupId>();
  for (const id of ids) {
    out.add(id);
    const groupId = doc.item(id)?.groupId;
    if (groupId === undefined || seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);
    for (const memberId of doc.group(groupId)?.memberIds ?? []) out.add(memberId);
  }
  return out;
}

export function selectionBounds(doc: CanvasDocument, ids: Iterable<ItemId>): Rect | undefined {
  const rects: Rect[] = [];
  for (const id of ids) {
    const bounds = doc.index.boundsOf(id);
    if (bounds) rects.push(bounds);
  }
  return unionRects(rects);
}

/**
 * Mirror a selection about the centre of its own bounds.
 *
 * One rule at every selection size, and not by branching on the size: a
 * selection of one is this same expression about that item's own centre, where
 * the reflection is a no-op and the flip and the rotation are not. Flipping five
 * images in place would leave the arrangement unmirrored, which is not a mirror
 * of anything.
 *
 * Two operations per item, because appearance deliberately cannot move
 * anything: the flag flips through `item.appearance`, and the centre and
 * rotation move through the `item.transform` that has maintained the spatial
 * index since M01. The transform is emitted only when it actually differs, so
 * flipping a single unrotated item is one operation.
 */
export function flipSelection(
  doc: CanvasDocument,
  ids: Iterable<ItemId>,
  axis: FlipAxis,
): CanvasOperationBody[] {
  const selected = [...ids];
  const bounds = selectionBounds(doc, selected);
  if (!bounds) return [];
  const centre = rectCentre(bounds);
  const about = axis === 'x' ? centre.x : centre.y;

  const bodies: CanvasOperationBody[] = [];
  for (const id of selected) {
    const item = doc.item(id);
    if (!item) continue;
    bodies.push({
      type: 'item.appearance',
      itemId: id,
      appearance:
        axis === 'x'
          ? { ...item.appearance, flipX: !item.appearance.flipX }
          : { ...item.appearance, flipY: !item.appearance.flipY },
    });
    const reflected = reflectTransform(item.transform, axis, about);
    if (
      reflected.x !== item.transform.x ||
      reflected.y !== item.transform.y ||
      reflected.rotation !== item.transform.rotation
    ) {
      bodies.push({ type: 'item.transform', itemId: id, transform: reflected });
    }
  }
  return bodies;
}

/**
 * The smallest an item may be scaled to, in world units.
 *
 * A guess, and a named one: it exists so a long scroll cannot collapse a
 * selection to zero, which is unrecoverable by scrolling the other way because
 * every factor of zero is zero. See OPEN_QUESTIONS Q19.
 */
export const MIN_ITEM_SIZE = 1;

/**
 * Scale a selection about the centre of its own bounds.
 *
 * The same rule at every selection size, for the reason {@link flipSelection}
 * gives: a selection of one is this expression about that item's own centre,
 * and scaling five images in place would grow each one without moving them
 * apart — which is not a scale of the arrangement.
 *
 * Multiplicative, so it composes: a gesture is many small factors and their
 * product is the factor of the whole gesture. Rotation is untouched — an item's
 * angle is not a function of its size.
 */
export function scaleSelection(
  doc: CanvasDocument,
  ids: Iterable<ItemId>,
  factor: number,
): CanvasOperationBody[] {
  const selected = [...ids];
  const bounds = selectionBounds(doc, selected);
  if (!bounds || !(factor > 0) || factor === 1) return [];
  const centre = rectCentre(bounds);

  const items = selected.flatMap((id) => doc.item(id) ?? []);
  // Refused as a whole rather than per item: shrinking a selection until its
  // smallest member hits the floor and then continuing would pull the rest in
  // around a member that had stopped, which silently rearranges the board.
  if (items.some((i) => Math.min(i.transform.width, i.transform.height) * factor < MIN_ITEM_SIZE)) {
    return [];
  }

  return items.map((item) => ({
    type: 'item.transform',
    itemId: item.id,
    transform: {
      ...item.transform,
      x: centre.x + (item.transform.x - centre.x) * factor,
      y: centre.y + (item.transform.y - centre.y) * factor,
      width: item.transform.width * factor,
      height: item.transform.height * factor,
    },
  }));
}

/**
 * Rotate a selection about the centre of its own bounds.
 *
 * Two things move per item and both must: the item's own angle, and its centre
 * around the selection's. Rotating each item in place would spin five images
 * without turning the arrangement they form, which is the same mistake
 * {@link flipSelection} avoids by mirroring about the bounds rather than about
 * each item.
 */
export function rotateSelection(
  doc: CanvasDocument,
  ids: Iterable<ItemId>,
  radians: number,
): CanvasOperationBody[] {
  const selected = [...ids];
  const bounds = selectionBounds(doc, selected);
  if (!bounds || radians === 0) return [];
  const centre = rectCentre(bounds);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return selected.flatMap((id) => {
    const item = doc.item(id);
    if (!item) return [];
    const dx = item.transform.x - centre.x;
    const dy = item.transform.y - centre.y;
    return [
      {
        type: 'item.transform',
        itemId: id,
        transform: {
          ...item.transform,
          x: centre.x + dx * cos - dy * sin,
          y: centre.y + dx * sin + dy * cos,
          rotation: item.transform.rotation + radians,
        },
      } satisfies CanvasOperationBody,
    ];
  });
}

/**
 * The operations that put these items back exactly as they are now.
 *
 * For a gesture that adjusts the document live and owes history ONE entry: take
 * this before it starts, take it again when it settles, then restore and commit
 * the second — so the undo stack sees one change from the state before the
 * gesture, not one per wheel tick. Transform and appearance both carry whole
 * state, which is what makes replaying them idempotent.
 */
export function selectionState(doc: CanvasDocument, ids: Iterable<ItemId>): CanvasOperationBody[] {
  const bodies: CanvasOperationBody[] = [];
  for (const id of ids) {
    const item = doc.item(id);
    if (!item) continue;
    bodies.push({ type: 'item.transform', itemId: id, transform: item.transform });
    bodies.push({ type: 'item.appearance', itemId: id, appearance: item.appearance });
  }
  return bodies;
}
