/**
 * Which framed group a dropped item belongs to.
 *
 * One rule, shared by the drop and the live preview so the preview cannot lie,
 * judged by the item's CENTRE:
 *
 * - A member of a framed group stays while its centre is inside that frame as
 *   it was drawn before the drag. Not the outline the other members make: a
 *   member in a corner would leave on any nudge, because its corner is empty
 *   without it.
 * - Otherwise it belongs to the framed group whose outline WITHOUT the dragged
 *   items holds its centre — the smallest one when outlines overlap — or to none.
 *
 * Decided on release only. Crossing out and back mid-drag changes nothing, which
 * gives the stability of hysteresis without a second threshold.
 */

import type { CanvasDocument } from './document';
import { type Rect, type Transform, transformBounds } from './geometry';
import type { GroupId, ItemId } from './ids';
import type { CanvasOperationBody } from './operations';
import { groupOutline } from './outline';

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Even–odd ray cast. Exact for the orthogonal rings {@link groupOutline} draws. */
function inRing(ring: readonly Pt[], p: Pt): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

function ringArea(ring: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Pt;
    const b = ring[(i + 1) % ring.length] as Pt;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

/** The outline a framed group's members make without `exclude`, or [] when none are left. */
export function outlineWithout(
  doc: CanvasDocument,
  groupId: GroupId,
  exclude: ReadonlySet<ItemId>,
): Pt[] {
  const rects: Rect[] = [];
  for (const id of doc.group(groupId)?.memberIds ?? []) {
    if (exclude.has(id)) continue;
    const bounds = doc.index.boundsOf(id);
    if (bounds) rects.push(bounds);
  }
  return groupOutline(rects);
}

/**
 * The framed group whose outline (without `exclude`) holds `point`, the
 * smallest when outlines overlap. Unframed groups have no boundary and are
 * never hit; neither is a group with no members left outside `exclude`.
 *
 * ponytail: scans every framed group, rasterising each outline. Fine for the
 * tens of frames a board has; index framed outlines spatially if that grows.
 */
export function frameAt(
  doc: CanvasDocument,
  point: Pt,
  exclude: ReadonlySet<ItemId>,
): GroupId | undefined {
  let best: GroupId | undefined;
  let bestArea = Infinity;
  for (const group of doc.groups()) {
    if (!group.frame) continue;
    const ring = outlineWithout(doc, group.id, exclude);
    if (ring.length === 0 || !inRing(ring, point)) continue;
    const area = ringArea(ring);
    if (area < bestArea) {
      best = group.id;
      bestArea = area;
    }
  }
  return best;
}

const none: ReadonlySet<ItemId> = new Set();

function centre(t: Transform): Pt {
  const b = transformBounds(t);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * Where each dragged item would belong if released at `positions`: its new
 * group, or `null` for loose. Items whose membership the drop does not touch
 * are absent — members of groups carried whole, and members of unframed groups.
 */
export function dropTargets(
  doc: CanvasDocument,
  positions: ReadonlyMap<ItemId, Transform>,
): Map<ItemId, GroupId | null> {
  const dragged = new Set(positions.keys());
  const out = new Map<ItemId, GroupId | null>();
  for (const [id, transform] of positions) {
    const current = doc.item(id)?.groupId;
    const group = current !== undefined ? doc.group(current) : undefined;
    if (group) {
      // Carried whole: groups do not nest, so a whole group never joins another.
      if (group.memberIds.every((m) => dragged.has(m))) continue;
      // No visible boundary to cross.
      if (!group.frame) continue;
    }
    const point = centre(transform);
    if (group && inRing(outlineWithout(doc, group.id, none), point)) continue;
    const target = frameAt(doc, point, dragged) ?? null;
    if (target !== (current ?? null)) out.set(id, target);
  }
  return out;
}

/**
 * The `group.members` bodies a drop at `positions` makes: one per touched
 * group, each carrying that group's full final member list. Commit them in the
 * same batch as the drop's transforms, so moving and joining are one undo step.
 */
export function membershipBodies(
  doc: CanvasDocument,
  positions: ReadonlyMap<ItemId, Transform>,
): CanvasOperationBody[] {
  const moves = dropTargets(doc, positions);
  if (moves.size === 0) return [];
  const members = new Map<GroupId, ItemId[]>();
  const listOf = (g: GroupId) => {
    let list = members.get(g);
    if (!list) {
      list = [...(doc.group(g)?.memberIds ?? [])];
      members.set(g, list);
    }
    return list;
  };
  for (const [id, target] of moves) {
    const current = doc.item(id)?.groupId;
    if (current !== undefined) {
      const list = listOf(current);
      list.splice(list.indexOf(id), 1);
    }
    if (target !== null) listOf(target).push(id);
  }
  return [...members].map(([groupId, memberIds]) => ({
    type: 'group.members' as const,
    groupId,
    memberIds,
  }));
}
