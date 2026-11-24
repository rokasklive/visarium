/**
 * The derived outline around a group of rectangles.
 *
 * A frame that is the group's bounding box lies about irregular arrangements:
 * an L-shaped cluster of references would claim the whole rectangle, empty
 * corner included. This module derives an orthogonal contour that follows the
 * members' actual extent — rectangular for a tight grid, stepped and concave
 * for anything looser — by snapping padded member bounds to a coarse grid and
 * tracing the boundary of the occupied cells. Members spread too far apart to
 * trace as one region get their bounding box instead: the frame always
 * encloses every member.
 *
 * Pure geometry on purpose: it lives in canvas-core so it can be unit-tested
 * without a renderer, and so the renderer stays a consumer of points. The
 * result is DERIVED STATE, never persisted; the renderer recomputes it when
 * the members move and caches the answer in between.
 */

import { expandRect, type Rect } from './geometry';

/**
 * The board's unit of scale, in world units.
 *
 * One number owns two things deliberately: the ground grid the renderer draws,
 * and the snap grid these outlines are built on — so a framed group visibly
 * sits on the cells the surface shows. A hypothesis with a milestone attached;
 * see OPEN_QUESTIONS.
 */
export const GRID_PITCH = 24;

/**
 * Ceiling on cells per axis when rasterising one group.
 *
 * Cell count grows with (group extent / pitch)², and a giant group of tiny
 * items must not turn into a giant loop. When a span would exceed this, the
 * pitch is scaled up for that group alone — coarser, never unbounded.
 */
export const MAX_OUTLINE_CELLS = 128;

export interface OutlineOptions {
  /** World units between grid lines. Defaults to {@link GRID_PITCH}. */
  readonly pitch?: number;
  /** How far the contour stands off each member's bounds. Defaults to half a cell. */
  readonly margin?: number;
  /** Cells per axis ceiling. Defaults to {@link MAX_OUTLINE_CELLS}. */
  readonly maxCells?: number;
}

interface Pt {
  x: number;
  y: number;
}

/**
 * The outer contour around `memberRects`, as an ordered ring of vertices.
 *
 * Returns [] for no input. Otherwise returns at least 4 vertices; the ring is
 * implicit — the last vertex connects to the first, and none is duplicated.
 * Holes do not survive: four members arranged in a square enclose their middle
 * rather than tracing around it, which is what "chalked around a collection"
 * should mean.
 */
export function groupOutline(memberRects: readonly Rect[], options: OutlineOptions = {}): Pt[] {
  if (memberRects.length === 0) return [];

  const margin = options.margin ?? (options.pitch ?? GRID_PITCH) / 2;
  let pitch = options.pitch ?? GRID_PITCH;
  const maxCells = options.maxCells ?? MAX_OUTLINE_CELLS;

  const padded = memberRects.map((r) => expandRect(r, margin));

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of padded) {
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  // Scale the pitch up before rasterising if this group is too large to
  // rasterise at the shared one. Per-group, so nobody else's outline changes.
  const spanCells = Math.max(maxX - minX, maxY - minY) / pitch;
  if (spanCells > maxCells) {
    pitch *= Math.ceil(spanCells / maxCells);
  }

  // Rasterise: every cell any padded member touches becomes occupied.
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const parseKey = (k: string): [number, number] => {
    const i = k.indexOf(',');
    return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
  };
  const occupied = new Set<string>();
  for (const r of padded) {
    for (let cy = Math.floor(r.minY / pitch); cy <= Math.ceil(r.maxY / pitch) - 1; cy++) {
      for (let cx = Math.floor(r.minX / pitch); cx <= Math.ceil(r.maxX / pitch) - 1; cx++) {
        occupied.add(key(cx, cy));
      }
    }
  }

  // Close the cell set: dilate by one cell, then erode by one.
  //
  // Members a couple of cells apart are ONE cluster to the eye — a chalk line
  // drawn around them crosses the gap instead of tracing two separate rings —
  // but in cell space the gap is a moat the exterior flood would pour through,
  // fragmenting the contour. Closing bridges gaps up to a cell wide while
  // leaving a solid region's outer boundary where it was: dilation grows it by
  // one and erosion takes that one back. Bounded by the same clamp as below.
  const dilated = new Set<string>();
  for (const cell of occupied) {
    const [cx, cy] = parseKey(cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        dilated.add(key(cx + dx, cy + dy));
      }
    }
  }
  const closed = new Set<string>();
  for (const cell of dilated) {
    const [cx, cy] = parseKey(cell);
    let full = true;
    for (let dy = -1; dy <= 1 && full; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dilated.has(key(cx + dx, cy + dy))) {
          full = false;
          break;
        }
      }
    }
    if (full) closed.add(cell);
  }

  // Flood the exterior from the bounding box's empty border. What stays
  // unreached-but-empty is a hole, and holes get filled by simply never
  // generating their edges below.
  const c0x = Math.floor(minX / pitch);
  const c0y = Math.floor(minY / pitch);
  const c1x = Math.ceil(maxX / pitch) - 1;
  const c1y = Math.ceil(maxY / pitch) - 1;
  const exterior = new Set<string>();
  const queue: [number, number][] = [];
  for (let cx = c0x - 1; cx <= c1x + 1; cx++) {
    queue.push([cx, c0y - 1], [cx, c1y + 1]);
  }
  for (let cy = c0y; cy <= c1y; cy++) {
    queue.push([c0x - 1, cy], [c1x + 1, cy]);
  }
  while (queue.length > 0) {
    const cell = queue.pop();
    if (!cell) continue;
    const [cx, cy] = cell;
    if (cx < c0x - 1 || cx > c1x + 1 || cy < c0y - 1 || cy > c1y + 1) continue;
    if (closed.has(key(cx, cy)) || exterior.has(key(cx, cy))) continue;
    exterior.add(key(cx, cy));
    queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }

  // Directed boundary edges, clockwise around occupied land (screen coords,
  // y down). An edge exists exactly where occupied land meets the exterior,
  // which is why hole interiors generate nothing.
  const outgoing = new Map<string, Pt[]>();
  const addEdge = (fromCell: [number, number], toCell: [number, number]) => {
    const k = `${fromCell[0]},${fromCell[1]}`;
    const to: Pt = { x: toCell[0], y: toCell[1] };
    const list = outgoing.get(k);
    if (list) list.push(to);
    else outgoing.set(k, [to]);
  };
  for (const cell of closed) {
    const [cx, cy] = parseKey(cell);
    if (exterior.has(key(cx, cy - 1))) addEdge([cx, cy], [cx + 1, cy]);
    if (exterior.has(key(cx + 1, cy))) addEdge([cx + 1, cy], [cx + 1, cy + 1]);
    if (exterior.has(key(cx, cy + 1))) addEdge([cx + 1, cy + 1], [cx, cy + 1]);
    if (exterior.has(key(cx - 1, cy))) addEdge([cx, cy + 1], [cx, cy]);
  }

  // Chain edges into loops. Normally the boundary is one loop. More than one
  // means the members fell apart into separate clusters (or regions touching
  // only at a grid corner), and no single traced ring encloses them all — so
  // the frame becomes the snapped bounding box of every member. Never a ring
  // around some of them: a frame that leaves a member outside claims that
  // member is not in the group. The box is also the shape server collision
  // already treats as the group.
  const toWorld = (c: Pt): Pt => ({ x: c.x * pitch, y: c.y * pitch });
  let best: Pt[] | undefined;
  let bestArea = -1;
  let bestStartKey = '';
  let rings = 0;
  while (true) {
    let startKey: string | undefined;
    for (const k of outgoing.keys()) {
      const list = outgoing.get(k);
      if (list && list.length > 0 && (!startKey || byCoordinate(k, startKey) < 0)) {
        startKey = k;
      }
    }
    if (!startKey) break;
    const first = parsePoint(startKey);
    const ring: Pt[] = [first];
    let current = first;
    let heading = 0;
    for (;;) {
      const candidates = outgoing.get(`${current.x},${current.y}`);
      if (!candidates || candidates.length === 0) break;
      let index = 0;
      for (let i = 0; i < candidates.length; i++) {
        const h = headingOf(current, candidates[i] as Pt);
        if (h === heading) {
          index = i; // straight ahead beats any turn
          break;
        }
        if (h === (heading + 1) % 4) index = i; // right turn beats left
      }
      const next = candidates.splice(index, 1)[0] as Pt;
      heading = headingOf(current, next);
      if (next.x === first.x && next.y === first.y) break;
      ring.push(next);
      current = next;
    }
    rings++;
    const area = signedArea(ring.map(toWorld));
    if (area > bestArea || (area === bestArea && byCoordinate(startKey, bestStartKey) < 0)) {
      best = ring.map(toWorld);
      bestArea = area;
      bestStartKey = startKey;
    }
  }
  if (rings > 1) {
    return [
      { x: c0x, y: c0y },
      { x: c1x + 1, y: c0y },
      { x: c1x + 1, y: c1y + 1 },
      { x: c0x, y: c1y + 1 },
    ].map(toWorld);
  }
  return mergeCollinear(best ?? []);
}

function byCoordinate(a: string, b: string): number {
  const [ax, ay] = parsePair(a);
  const [bx, by] = parsePair(b);
  return ay - by || ax - bx;
}

function parsePair(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

function parsePoint(key: string): Pt {
  const [x, y] = parsePair(key);
  return { x: x as number, y: y as number };
}

/** Signed area by the shoelace formula; sign says which way the ring turns. */
function signedArea(ring: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Pt;
    const b = ring[(i + 1) % ring.length] as Pt;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function headingOf(from: Pt, to: Pt): number {
  if (to.y === from.y) return to.x > from.x ? 0 : 2;
  return to.y > from.y ? 1 : 3;
}

/** Drop every vertex that merely continues its neighbours' shared direction. */
function mergeCollinear(ring: readonly Pt[]): Pt[] {
  if (ring.length < 4) return [...ring];
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length] as Pt;
    const cur = ring[i] as Pt;
    const next = ring[(i + 1) % ring.length] as Pt;
    const straight =
      (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!straight) out.push(cur);
  }
  return out.length >= 4 ? out : [...ring];
}
