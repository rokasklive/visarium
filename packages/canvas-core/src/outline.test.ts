import { describe, expect, it } from 'vitest';
import { rect } from './geometry';
import { GRID_PITCH, groupOutline, MAX_OUTLINE_CELLS } from './outline';

/** Even-odd ray cast; exact enough for orthogonal polygons on grid points. */
function inside(ring: { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as { x: number; y: number };
    const b = ring[j] as { x: number; y: number };
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

function bounds(ring: readonly { x: number; y: number }[]) {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** A ring is closed when every consecutive pair shares an axis, last included. */
function orthogonalClosed(ring: readonly { x: number; y: number }[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as { x: number; y: number };
    const b = ring[(i + 1) % ring.length] as { x: number; y: number };
    if (a.x !== b.x && a.y !== b.y) return false;
  }
  return ring.length >= 4 && new Set(ring.map((p) => `${p.x},${p.y}`)).size === ring.length;
}

describe('groupOutline', () => {
  it('returns nothing for no members', () => {
    expect(groupOutline([])).toEqual([]);
  });

  it('rings a single member on snapped cell boundaries', () => {
    const ring = groupOutline([rect(0, 0, 100, 100)]);
    expect(orthogonalClosed(ring)).toBe(true);
    // Padded by half a cell, then snapped OUTWARD to whole cells.
    expect(bounds(ring)).toEqual({ minX: -24, minY: -24, maxX: 120, maxY: 120 });
  });

  it('keeps an L-shape concave — the empty corner stays outside', () => {
    // An arm across the top and a foot down the left; the bounding box would
    // also claim the empty lower-right region.
    const ring = groupOutline([rect(0, 0, 300, 100), rect(0, 100, 100, 300)]);
    expect(orthogonalClosed(ring)).toBe(true);
    expect(ring.length).toBeGreaterThan(4);
    expect(inside(ring, { x: 250, y: 250 })).toBe(false); // empty corner
    expect(inside(ring, { x: 50, y: 150 })).toBe(true); // inside the foot
  });

  it('degenerates to near-rectangle for a tight grid and fills holes', () => {
    const cells = [
      rect(0, 0, 100, 100),
      rect(100, 0, 200, 100),
      rect(0, 100, 100, 200),
      rect(100, 100, 200, 200),
    ];
    const ring = groupOutline(cells);
    expect(orthogonalClosed(ring)).toBe(true);
    // The middle point where all four meet is enclosed, not traced around.
    expect(inside(ring, { x: 100, y: 100 })).toBe(true);
    expect(ring.length).toBeLessThanOrEqual(8);
  });

  it('encloses overlapping members once', () => {
    const ring = groupOutline([rect(0, 0, 100, 100), rect(50, 50, 150, 150)]);
    expect(orthogonalClosed(ring)).toBe(true);
    expect(inside(ring, { x: 75, y: 75 })).toBe(true);
  });

  it('scales the pitch up rather than rasterising an unbounded span', () => {
    const huge: ReturnType<typeof rect>[] = [rect(0, 0, 1_000_000, 10)];
    const ring = groupOutline(huge);
    expect(orthogonalClosed(ring)).toBe(true);
    const b = bounds(ring);
    expect(b.maxX).toBeGreaterThanOrEqual(1_000_000);
    // Coarser than the shared pitch: that is what the clamp is for.
    expect(b.maxX - b.minX).toBeGreaterThan(4 * MAX_OUTLINE_CELLS * GRID_PITCH);
  });

  it('bridges members a couple of cells apart into one ring', () => {
    // Three references with real gaps between them — 46 and 51 world units,
    // more than the padding — are one cluster to the eye. In cell space those
    // gaps are moats: without closing, the exterior flood pours through them
    // and the contour fragments into one ring per member.
    const ring = groupOutline([
      { minX: -300, minY: -270, maxX: 100, maxY: 30 },
      { minX: 170, minY: -340, maxX: 470, maxY: 60 },
      { minX: -255, minY: 105, maxX: 95, maxY: 455 },
    ]);
    expect(orthogonalClosed(ring)).toBe(true);
    const b = bounds(ring);
    // One ring spanning all three, not three rings or the largest one.
    expect(b.minX).toBeLessThanOrEqual(-312);
    expect(b.maxX).toBeGreaterThanOrEqual(470);
    expect(inside(ring, { x: 0, y: 0 })).toBe(true); // top-left member
    expect(inside(ring, { x: 300, y: 0 })).toBe(true); // top-right member
    expect(inside(ring, { x: 0, y: 300 })).toBe(true); // the foot
  });

  it('survives members that touch only at a grid corner', () => {
    const ring = groupOutline([rect(0, 0, 100, 100), rect(100, 100, 200, 200)]);
    expect(orthogonalClosed(ring)).toBe(true);
    expect(inside(ring, { x: 50, y: 50 })).toBe(true);
    expect(inside(ring, { x: 150, y: 150 })).toBe(true);
  });

  it('encloses every member when they fall apart into clusters', () => {
    const members = [rect(0, 0, 100, 100), rect(0, 120, 100, 220), rect(2000, 0, 2100, 100)];
    const ring = groupOutline(members);
    expect(orthogonalClosed(ring)).toBe(true);
    for (const m of members) {
      expect(inside(ring, { x: (m.minX + m.maxX) / 2, y: (m.minY + m.maxY) / 2 })).toBe(true);
    }
  });

  it('does not let a large far member take the frame from the small ones', () => {
    // Before: the largest ring won, so the frame jumped to the image alone.
    const ring = groupOutline([
      rect(0, 0, 100, 100),
      rect(0, 120, 100, 220),
      rect(1000, 0, 1400, 400),
    ]);
    expect(inside(ring, { x: 50, y: 50 })).toBe(true);
    expect(inside(ring, { x: 50, y: 170 })).toBe(true);
    expect(inside(ring, { x: 1200, y: 200 })).toBe(true);
  });

  it('honours an explicit pitch and margin, snapped outward', () => {
    const ring = groupOutline([rect(0, 0, 100, 100)], { pitch: 50, margin: 25 });
    expect(bounds(ring)).toEqual({ minX: -50, minY: -50, maxX: 150, maxY: 150 });
  });
});
