/**
 * World-space geometry.
 *
 * World space is unbounded float64 with y pointing down, matching the browser's
 * screen convention so the camera transform stays a pure scale + translate.
 *
 * An item's placement is a {@link Transform}: `(x, y)` is the CENTRE of the
 * unrotated box and `rotation` turns it about that centre. Centre-origin makes
 * rotation, axis-aligned bounds and group bounds symmetric; renderers that use
 * a top-left origin (Konva does) convert at the adapter boundary.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle in world space. */
export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface Transform {
  /** Centre X in world space. */
  readonly x: number;
  /** Centre Y in world space. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Radians, clockwise, about the centre. */
  readonly rotation: number;
}

export const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
};

export function rect(minX: number, minY: number, maxX: number, maxY: number): Rect {
  return { minX, minY, maxX, maxY };
}

export function rectWidth(r: Rect): number {
  return r.maxX - r.minX;
}

export function rectHeight(r: Rect): number {
  return r.maxY - r.minY;
}

export function rectCentre(r: Rect): Vec2 {
  return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

/** Touching edges count as intersecting; the spatial index uses the same rule. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

export function expandRect(r: Rect, margin: number): Rect {
  return {
    minX: r.minX - margin,
    minY: r.minY - margin,
    maxX: r.maxX + margin,
    maxY: r.maxY + margin,
  };
}

/** Union of rects. Returns `undefined` for an empty input so callers must handle "no bounds". */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    if (r.minX < minX) minX = r.minX;
    if (r.minY < minY) minY = r.minY;
    if (r.maxX > maxX) maxX = r.maxX;
    if (r.maxY > maxY) maxY = r.maxY;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Axis-aligned bounding box of a possibly-rotated transform.
 *
 * The spatial index stores AABBs, so a rotated item is indexed by a box that is
 * larger than the item itself. Queries are therefore conservative: they may
 * return items whose rotated shape does not truly intersect. Callers that need
 * exactness (marquee selection) refine with {@link transformCorners}.
 */
export function transformBounds(t: Transform): Rect {
  const hw = t.width / 2;
  const hh = t.height / 2;
  if (t.rotation === 0) {
    return { minX: t.x - hw, minY: t.y - hh, maxX: t.x + hw, maxY: t.y + hh };
  }
  const cos = Math.abs(Math.cos(t.rotation));
  const sin = Math.abs(Math.sin(t.rotation));
  const ehw = hw * cos + hh * sin;
  const ehh = hw * sin + hh * cos;
  return { minX: t.x - ehw, minY: t.y - ehh, maxX: t.x + ehw, maxY: t.y + ehh };
}

/**
 * Which coordinate a reflection negates.
 *
 * `'x'` is a horizontal flip — a mirror in a VERTICAL axis line, which is the
 * one people mean when they say "flip horizontally". `'y'` is its counterpart.
 */
export type FlipAxis = 'x' | 'y';

/**
 * Mirror a transform across an axis at `about`.
 *
 * Two terms, and the second is the one that is easy to leave out: the centre
 * reflects, and the rotation NEGATES, because a reflection reverses
 * orientation. Without it a mirrored collage of rotated references comes back
 * subtly wrong in a way nobody can name, and a test checking positions alone
 * would pass.
 *
 * Size is untouched. A flip is never a negative width — see `Appearance`.
 */
export function reflectTransform(t: Transform, axis: FlipAxis, about: number): Transform {
  return axis === 'x'
    ? { ...t, x: 2 * about - t.x, rotation: -t.rotation }
    : { ...t, y: 2 * about - t.y, rotation: -t.rotation };
}

/** The four corners of a transform, clockwise from top-left of the unrotated box. */
export function transformCorners(t: Transform): [Vec2, Vec2, Vec2, Vec2] {
  const hw = t.width / 2;
  const hh = t.height / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const at = (dx: number, dy: number): Vec2 => ({
    x: t.x + dx * cos - dy * sin,
    y: t.y + dx * sin + dy * cos,
  });
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** True if the (possibly rotated) item overlaps an axis-aligned rect. Separating-axis test. */
export function transformIntersectsRect(t: Transform, r: Rect): boolean {
  if (!rectsIntersect(transformBounds(t), r)) return false;
  if (t.rotation === 0) return true;

  const corners = transformCorners(t);
  const rectCorners: Vec2[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  // World axes are already covered by the AABB test above; only the item's own
  // two axes remain.
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  for (const axis of [
    { x: cos, y: sin },
    { x: -sin, y: cos },
  ]) {
    if (isSeparating(axis, corners, rectCorners)) return false;
  }
  return true;
}

function isSeparating(axis: Vec2, a: readonly Vec2[], b: readonly Vec2[]): boolean {
  const [aMin, aMax] = project(axis, a);
  const [bMin, bMax] = project(axis, b);
  return aMax < bMin || bMax < aMin;
}

function project(axis: Vec2, points: readonly Vec2[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}
