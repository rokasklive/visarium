import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  DEFAULT_CAMERA,
  fitRect,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from './camera';
import { rect } from './geometry';

const size = { width: 1600, height: 900 };

describe('camera', () => {
  it('places the camera position at the viewport centre', () => {
    expect(worldToScreen({ x: 5, y: 7, zoom: 2 }, size, { x: 5, y: 7 })).toEqual({
      x: 800,
      y: 450,
    });
  });

  it('round-trips world -> screen -> world', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        (x, y, zoom) => {
          const camera = { x: 0, y: 0, zoom };
          const back = screenToWorld(camera, size, worldToScreen(camera, size, { x, y }));
          expect(back.x).toBeCloseTo(x, 4);
          expect(back.y).toBeCloseTo(y, 4);
        },
      ),
    );
  });

  it('keeps the anchored world point fixed while zooming', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1600, noNaN: true }),
        fc.double({ min: 0, max: 900, noNaN: true }),
        fc.double({ min: 0.02, max: 20, noNaN: true }),
        (ax, ay, nextZoom) => {
          const camera = { x: 123, y: -45, zoom: 1.5 };
          const anchor = { x: ax, y: ay };
          const before = screenToWorld(camera, size, anchor);
          const after = screenToWorld(zoomAt(camera, size, anchor, nextZoom), size, anchor);
          expect(after.x).toBeCloseTo(before.x, 4);
          expect(after.y).toBeCloseTo(before.y, 4);
        },
      ),
    );
  });

  it('clamps zoom to the supported range', () => {
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(zoomAt(DEFAULT_CAMERA, size, { x: 0, y: 0 }, 1e9).zoom).toBe(MAX_ZOOM);
  });

  it('pans by screen pixels scaled into world units', () => {
    const panned = panBy({ x: 0, y: 0, zoom: 2 }, 100, 50);
    expect(panned).toEqual({ x: -50, y: -25, zoom: 2 });
  });

  it('visibleWorldRect shrinks as zoom grows', () => {
    const wide = visibleWorldRect({ x: 0, y: 0, zoom: 0.5 }, size);
    const tight = visibleWorldRect({ x: 0, y: 0, zoom: 4 }, size);
    expect(wide.maxX - wide.minX).toBeGreaterThan(tight.maxX - tight.minX);
  });

  it('fitRect frames the target within the viewport', () => {
    const target = rect(-500, -200, 500, 200);
    const camera = fitRect(size, target);
    const visible = visibleWorldRect(camera, size);
    expect(visible.minX).toBeLessThanOrEqual(target.minX);
    expect(visible.maxX).toBeGreaterThanOrEqual(target.maxX);
    expect(visible.minY).toBeLessThanOrEqual(target.minY);
    expect(visible.maxY).toBeGreaterThanOrEqual(target.maxY);
  });

  /**
   * What framing must not do at the two ends: a 64px icon is not worth 32x, and
   * a board a hundred thousand items wide still has to leave a camera the rest
   * of the code can work with.
   */
  it('fitRect clamps at both ends rather than trusting the target', () => {
    // 20 world units tall in a 900px viewport wants 40x; the clamp says 32.
    expect(fitRect(size, rect(-10, -10, 10, 10)).zoom).toBe(MAX_ZOOM);
    expect(fitRect(size, rect(-5e6, -5e6, 5e6, 5e6)).zoom).toBe(MIN_ZOOM);
  });

  it('fitRect centres on the target whatever the clamp did to the zoom', () => {
    expect(fitRect(size, rect(100, 200, 300, 600))).toMatchObject({ x: 200, y: 400 });
  });
});

/**
 * Why a burst of wheel events can be applied once per frame.
 *
 * Multiplicative zoom composes — `exp(-Sum d) = Prod exp(-d)` — so accumulating
 * the deltas and applying the sum at the anchor gives the same camera as
 * applying each event in turn at that anchor. This is the arithmetic the
 * coalescing in `canvas-surface.tsx` rests on; if it stopped holding, a
 * trackpad flick would land somewhere different from where it used to.
 */
describe('wheel coalescing is exact, not an approximation', () => {
  const anchor = { x: 400, y: 250 };
  const zoomBy = (camera: typeof DEFAULT_CAMERA, delta: number) =>
    zoomAt(camera, size, anchor, camera.zoom * Math.exp(-delta));

  it('applying a burst one by one equals applying its sum once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -0.3, max: 0.3, noNaN: true }), { minLength: 1, maxLength: 40 }),
        (deltas) => {
          const stepped = deltas.reduce(zoomBy, DEFAULT_CAMERA);
          const coalesced = zoomBy(
            DEFAULT_CAMERA,
            deltas.reduce((sum, d) => sum + d, 0),
          );

          expect(coalesced.zoom).toBeCloseTo(stepped.zoom, 9);
          expect(coalesced.x).toBeCloseTo(stepped.x, 6);
          expect(coalesced.y).toBeCloseTo(stepped.y, 6);
        },
      ),
    );
  });

  /**
   * And why the newest anchor is the right one: the anchored world point is what
   * stays put, so the frame must anchor where the pointer is when it is drawn,
   * not where the burst began.
   */
  it('anchors on the point it was given, which is the newest events', () => {
    const moved = { x: 900, y: 700 };
    const before = screenToWorld(DEFAULT_CAMERA, size, moved);
    const after = zoomAt(DEFAULT_CAMERA, size, moved, 4);

    expect(screenToWorld(after, size, moved).x).toBeCloseTo(before.x, 9);
    expect(screenToWorld(after, size, moved).y).toBeCloseTo(before.y, 9);
  });
});
