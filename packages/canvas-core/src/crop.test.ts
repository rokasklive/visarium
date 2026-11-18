import { describe, expect, it } from 'vitest';
import {
  clampEdges,
  cropFrame,
  fromEdges,
  movingEdges,
  normaliseCrop,
  originalTransform,
  resetCrop,
  slideCrop,
  visibleEdges,
} from './crop';
import type { Transform } from './geometry';
import { asItemId } from './ids';
import { type CanvasItem, type Crop, DEFAULT_APPEARANCE, FULL_CROP } from './model';

/** A 400×200 original shown at half size: 200×100 world units, centred on the origin. */
function item(
  over: { transform?: Partial<Transform>; crop?: Crop; flipX?: boolean; flipY?: boolean } = {},
): CanvasItem {
  return {
    id: asItemId('a'),
    transform: { x: 0, y: 0, width: 200, height: 100, rotation: 0, ...over.transform },
    z: 0,
    content: { kind: 'placeholder', intrinsicWidth: 400, intrinsicHeight: 200 },
    appearance: { ...DEFAULT_APPEARANCE, flipX: !!over.flipX, flipY: !!over.flipY },
    crop: over.crop ?? FULL_CROP,
  };
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

/** One crop gesture end to end: anchor, proposed edge positions, result. */
function drag(it: CanvasItem, anchor: string, proposed: Partial<ReturnType<typeof visibleEdges>>) {
  const frame = cropFrame(it);
  const was = visibleEdges(it, frame);
  const edges = clampEdges(frame, was, { ...was, ...proposed }, movingEdges(anchor), 4);
  return fromEdges(it, frame, edges);
}

describe('cropping an edge', () => {
  it('moves only the dragged edge and keeps the scale', () => {
    const { transform, crop } = drag(item(), 'middle-right', { right: 150 });
    expect(crop).toEqual({ x: 0, y: 0, width: 0.75, height: 1 });
    close(transform.width, 150);
    // Left edge stays at -100: the centre moved by half the trim.
    close(transform.x - transform.width / 2, -100);
    // Scale: 150 world units for 0.75 × 400 px = 0.5, unchanged.
    close(transform.width / (crop.width * 400), 0.5);
  });

  it('keeps the opposite edge still when the proposal moved both (Konva under Alt)', () => {
    const { transform } = drag(item(), 'middle-left', { left: 40, right: 160 });
    close(transform.x + transform.width / 2, 100);
    close(transform.x - transform.width / 2, -60);
  });

  it('moves two edges from a corner', () => {
    const { crop } = drag(item(), 'top-left', { left: 50, top: 50 });
    expect(crop).toEqual({ x: 0.25, y: 0.5, width: 0.75, height: 0.5 });
  });

  it('stops at the original edge when un-cropping past it', () => {
    const cropped = item({
      transform: { x: 25, width: 150 },
      crop: { x: 0.25, y: 0, width: 0.75, height: 1 },
    });
    const { transform, crop } = drag(cropped, 'middle-left', { left: -500 });
    expect(crop).toEqual(FULL_CROP);
    close(transform.width, 200);
    close(transform.x, 0);
  });

  it('never goes below the minimum size or past the opposite edge', () => {
    const { transform } = drag(item(), 'middle-right', { right: -900 });
    close(transform.width, 4);
  });
});

describe('frames', () => {
  it('places the whole original around a cropped item', () => {
    const cropped = item({
      transform: { x: 25, width: 150 },
      crop: { x: 0.25, y: 0, width: 0.75, height: 1 },
    });
    expect(originalTransform(cropFrame(cropped))).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 0,
    });
  });

  it('works rotated: cropping the right edge keeps the left edge in world space', () => {
    const rotation = Math.PI / 2; // the item's right edge now points down
    const it = item({ transform: { rotation } });
    const { transform } = drag(it, 'middle-right', { right: 100 });
    // Local left edge at (-100, 0) rotated 90° is world (0, -100); the new centre
    // is 50 along the local x axis from it, i.e. world (0, -50).
    close(transform.x, 0);
    close(transform.y, -50);
    close(transform.rotation, rotation);
  });
});

describe('flips', () => {
  it('trims the edge the person sees, which is the source opposite side', () => {
    const { crop, transform } = drag(item({ flipX: true }), 'middle-left', { left: 50 });
    // Visible left quarter gone → source RIGHT quarter hidden.
    expect(crop).toEqual({ x: 0, y: 0, width: 0.75, height: 1 });
    close(transform.x - transform.width / 2, -50);
  });

  it('round-trips a flipped crop through its own frame', () => {
    const it = item({
      // Source left three quarters, mirrored: they show on the visible right.
      transform: { x: 25, width: 150 },
      crop: { x: 0, y: 0, width: 0.75, height: 1 },
      flipX: true,
    });
    expect(visibleEdges(it)).toEqual({ left: 50, top: 0, right: 200, bottom: 100 });
    expect(originalTransform(cropFrame(it)).x).toBeCloseTo(0, 9);
  });

  it('maps vertical flips the same way', () => {
    const { crop } = drag(item({ flipY: true }), 'top-center', { top: 50 });
    expect(crop).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
  });
});

describe('sliding', () => {
  const window = { x: 0.25, y: 0, width: 0.5, height: 1 };

  it('moves the content with the pointer and the window against it', () => {
    const it = item({ transform: { width: 100 }, crop: window });
    expect(slideCrop(it, { x: 50, y: 0 })).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  });

  it('stops before an edge of the original comes into view', () => {
    const it = item({ transform: { width: 100 }, crop: window });
    expect(slideCrop(it, { x: -9999, y: 0 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  it('follows the pointer on a flipped image too', () => {
    const it = item({ transform: { width: 100 }, crop: window, flipX: true });
    // Content follows right → visible window moves left → source window moves right.
    expect(slideCrop(it, { x: 50, y: 0 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });
});

describe('reset', () => {
  it('shows the whole original without moving what was visible', () => {
    const it = item({
      transform: { x: 50, y: 25, width: 100, height: 50 },
      crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    });
    const { transform, crop } = resetCrop(it);
    expect(crop).toEqual(FULL_CROP);
    expect(transform).toEqual({ x: 0, y: 0, width: 200, height: 100, rotation: 0 });
  });
});

describe('normalising', () => {
  it('snaps float drift to the full crop and keeps x + width within 1', () => {
    expect(normaliseCrop({ x: 1e-12, y: 0, width: 1 - 1e-12, height: 1 })).toBe(FULL_CROP);
    const c = normaliseCrop({ x: 0.3, y: 0, width: 0.7000000001, height: 1 });
    expect(c.x + c.width).toBeLessThanOrEqual(1);
    // One edge trimmed, the others drifted: the untouched edges come out exact.
    const drifted = normaliseCrop({ x: 0.18, y: -1e-14, width: 0.82, height: 0.9999999999999996 });
    expect(drifted.y).toBe(0);
    expect(drifted.height).toBe(1);
    expect(drifted.x + drifted.width).toBe(1);
  });
});
