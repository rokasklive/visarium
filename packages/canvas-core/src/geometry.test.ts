import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  expandRect,
  rect,
  rectContainsRect,
  rectsIntersect,
  reflectTransform,
  transformBounds,
  transformCorners,
  transformIntersectsRect,
  unionRects,
} from './geometry';

const finite = (max = 1e4) => fc.double({ min: -max, max, noNaN: true, noDefaultInfinity: true });
const positive = (max = 1e3) => fc.double({ min: 0.01, max, noNaN: true, noDefaultInfinity: true });

const arbTransform = fc.record({
  x: finite(),
  y: finite(),
  width: positive(),
  height: positive(),
  rotation: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
});

describe('transformBounds', () => {
  it('matches the unrotated box when rotation is zero', () => {
    const b = transformBounds({ x: 10, y: 20, width: 4, height: 6, rotation: 0 });
    expect(b).toEqual(rect(8, 17, 12, 23));
  });

  it('contains every corner, at any rotation', () => {
    fc.assert(
      fc.property(arbTransform, (t) => {
        const b = transformBounds(t);
        const epsilon = 1e-6 * Math.max(1, Math.abs(t.x) + Math.abs(t.y));
        for (const c of transformCorners(t)) {
          expect(c.x).toBeGreaterThanOrEqual(b.minX - epsilon);
          expect(c.x).toBeLessThanOrEqual(b.maxX + epsilon);
          expect(c.y).toBeGreaterThanOrEqual(b.minY - epsilon);
          expect(c.y).toBeLessThanOrEqual(b.maxY + epsilon);
        }
      }),
    );
  });

  it('is never smaller than the unrotated box', () => {
    fc.assert(
      fc.property(arbTransform, (t) => {
        const b = transformBounds(t);
        expect(b.maxX - b.minX).toBeGreaterThanOrEqual(Math.min(t.width, t.height) - 1e-9);
      }),
    );
  });
});

describe('transformIntersectsRect', () => {
  it('is conservative: a true hit always passes the AABB pre-filter', () => {
    fc.assert(
      fc.property(arbTransform, finite(), finite(), positive(), positive(), (t, x, y, w, h) => {
        const area = rect(x, y, x + w, y + h);
        if (transformIntersectsRect(t, area)) {
          expect(rectsIntersect(transformBounds(t), area)).toBe(true);
        }
      }),
    );
  });

  it('detects a rotated item whose AABB overlaps but whose body does not', () => {
    // A thin bar running top-left to bottom-right (y grows downward). Its AABB
    // covers the top-RIGHT corner; the bar itself comes nowhere near it.
    const bar = { x: 0, y: 0, width: 100, height: 2, rotation: Math.PI / 4 };
    const bounds = transformBounds(bar);
    const corner = rect(bounds.maxX - 5, bounds.minY, bounds.maxX, bounds.minY + 5);
    expect(rectsIntersect(bounds, corner)).toBe(true);
    expect(transformIntersectsRect(bar, corner)).toBe(false);
  });

  it('detects a genuine overlap at the centre', () => {
    const bar = { x: 0, y: 0, width: 100, height: 2, rotation: Math.PI / 4 };
    expect(transformIntersectsRect(bar, rect(-1, -1, 1, 1))).toBe(true);
  });
});

describe('rect helpers', () => {
  it('expandRect grows by the margin on every side', () => {
    expect(expandRect(rect(0, 0, 10, 10), 2)).toEqual(rect(-2, -2, 12, 12));
  });

  it('unionRects contains all inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(finite(), finite(), positive(), positive()), { minLength: 1 }),
        (raw) => {
          const rects = raw.map(([x, y, w, h]) => rect(x, y, x + w, y + h));
          const union = unionRects(rects);
          expect(union).toBeDefined();
          for (const r of rects) expect(rectContainsRect(union as never, r)).toBe(true);
        },
      ),
    );
  });

  it('unionRects of nothing is undefined', () => {
    expect(unionRects([])).toBeUndefined();
  });
});

describe('reflectTransform', () => {
  it('is an involution about the same axis', () => {
    fc.assert(
      fc.property(arbTransform, finite(), (t, about) => {
        const there = reflectTransform(t, 'x', about);
        const back = reflectTransform(there, 'x', about);
        expect(back.x).toBeCloseTo(t.x, 9);
        expect(back.rotation).toBeCloseTo(t.rotation, 12);
        expect(back.width).toBe(t.width);
        expect(back.height).toBe(t.height);
      }),
    );
  });

  it('negates rotation, because a reflection reverses orientation', () => {
    const t = { x: 10, y: 20, width: 4, height: 6, rotation: 0.7 };
    expect(reflectTransform(t, 'x', 10).rotation).toBe(-0.7);
    expect(reflectTransform(t, 'y', 20).rotation).toBe(-0.7);
  });

  it('leaves an item on the axis where it is', () => {
    const t = { x: 10, y: 20, width: 4, height: 6, rotation: 0 };
    // `-0` for the rotation, which compares equal to `0` everywhere it matters:
    // `flipSelection` skips the transform, and JSON writes it as `0`.
    expect(reflectTransform(t, 'x', 10).x).toBe(10);
    expect(reflectTransform(t, 'y', 20).y).toBe(20);
  });

  it('moves the other coordinate not at all', () => {
    const t = { x: 10, y: 20, width: 4, height: 6, rotation: 0 };
    expect(reflectTransform(t, 'x', 0).y).toBe(20);
    expect(reflectTransform(t, 'y', 0).x).toBe(10);
  });

  it('never produces a negative size', () => {
    fc.assert(
      fc.property(arbTransform, finite(), (t, about) => {
        const r = reflectTransform(t, 'y', about);
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThan(0);
      }),
    );
  });
});
