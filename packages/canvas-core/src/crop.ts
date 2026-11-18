/**
 * Crop geometry: pure, renderer-free arithmetic for ADR-0029.
 *
 * Everything here works in one frame, the ORIGINAL'S FRAME: the whole original
 * image as the person sees it (flip applied), unrotated, with its top-left
 * corner at the origin and the item's world units as the unit. The visible box
 * is a rectangle inside it, `0 ≤ left < right ≤ width`, and a crop is just that
 * rectangle divided by the frame's size, mapped back to source orientation.
 *
 * Working in what the person sees is what makes flip free: "the left edge" is
 * always the left edge on screen, and only `toCrop`/`fromCrop` know which side
 * of the source that is.
 */

import type { Transform, Vec2 } from './geometry';
import { type CanvasItem, type Crop, FULL_CROP } from './model';

/** The whole original, placed in world space. */
export interface CropFrame {
  /** World position of the frame's origin: the original's visible top-left. */
  readonly origin: Vec2;
  /** Radians, the item's rotation. */
  readonly rotation: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle in the original's frame. */
export interface Edges {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Which edges a handle moves. A corner moves two, a side one. */
export interface Moving {
  readonly left: boolean;
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
}

/** Below this, float drift from flips and rotations is noise, not a crop. */
const EPSILON = 1e-9;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Source-orientation crop → the visible box as fractions of the original. */
function visibleFractions(item: CanvasItem): Edges {
  const { crop } = item;
  const flipX = item.appearance.flipX;
  const flipY = item.appearance.flipY;
  const left = flipX ? 1 - crop.x - crop.width : crop.x;
  const top = flipY ? 1 - crop.y - crop.height : crop.y;
  return { left, top, right: left + crop.width, bottom: top + crop.height };
}

/**
 * The whole original in world space.
 *
 * Its size needs no intrinsic dimensions: the transform is the visible part,
 * and the crop says what fraction that is.
 */
export function cropFrame(item: CanvasItem): CropFrame {
  const t = item.transform;
  const width = t.width / item.crop.width;
  const height = t.height / item.crop.height;
  const f = visibleFractions(item);
  // Item centre, expressed in the frame, then walked back to the frame's corner.
  const centreInFrame = { x: f.left * width + t.width / 2, y: f.top * height + t.height / 2 };
  const back = rotate(centreInFrame, t.rotation);
  return { origin: { x: t.x - back.x, y: t.y - back.y }, rotation: t.rotation, width, height };
}

/** The whole original as a centre-origin transform: what the ghost draws. */
export function originalTransform(frame: CropFrame): Transform {
  const c = toWorld(frame, { x: frame.width / 2, y: frame.height / 2 });
  return { x: c.x, y: c.y, width: frame.width, height: frame.height, rotation: frame.rotation };
}

export function toWorld(frame: CropFrame, p: Vec2): Vec2 {
  const r = rotate(p, frame.rotation);
  return { x: frame.origin.x + r.x, y: frame.origin.y + r.y };
}

export function toFrame(frame: CropFrame, p: Vec2): Vec2 {
  return rotate({ x: p.x - frame.origin.x, y: p.y - frame.origin.y }, -frame.rotation);
}

/** Where the item's visible box sits in its own frame. */
export function visibleEdges(item: CanvasItem, frame: CropFrame = cropFrame(item)): Edges {
  const f = visibleFractions(item);
  return {
    left: f.left * frame.width,
    top: f.top * frame.height,
    right: f.right * frame.width,
    bottom: f.bottom * frame.height,
  };
}

/**
 * Move only the edges a handle owns, and keep them inside the original.
 *
 * `proposed` is whatever the handle reported. Taking from it only the moving
 * edges is what keeps the opposite edge still even when the input moved both —
 * Konva's Transformer does exactly that under Alt.
 */
export function clampEdges(
  frame: CropFrame,
  was: Edges,
  proposed: Edges,
  moving: Moving,
  minSize: number,
): Edges {
  const min = Math.min(minSize, frame.width, frame.height);
  let { left, top, right, bottom } = was;
  if (moving.left) left = clamp(proposed.left, 0, right - min);
  if (moving.right) right = clamp(proposed.right, left + min, frame.width);
  if (moving.top) top = clamp(proposed.top, 0, bottom - min);
  if (moving.bottom) bottom = clamp(proposed.bottom, top + min, frame.height);
  return { left, top, right, bottom };
}

/** Exact fractions inside `[0, 1]`, snapped to {@link FULL_CROP} when it is one. */
export function normaliseCrop(crop: Crop): Crop {
  // Each edge within drift of the original's edge IS that edge, so a crop that
  // only trimmed the right never stores a top of 1e-14 or a height of 0.9999….
  const x = crop.x < EPSILON ? 0 : clamp(crop.x, 0, 1);
  const y = crop.y < EPSILON ? 0 : clamp(crop.y, 0, 1);
  const width = x + crop.width > 1 - EPSILON ? 1 - x : clamp(crop.width, 0, 1 - x);
  const height = y + crop.height > 1 - EPSILON ? 1 - y : clamp(crop.height, 0, 1 - y);
  const full = x === 0 && y === 0 && width === 1 && height === 1;
  return full ? FULL_CROP : { x, y, width, height };
}

/** A box in the frame → the item's new transform and source-orientation crop. */
export function fromEdges(
  item: CanvasItem,
  frame: CropFrame,
  edges: Edges,
): { transform: Transform; crop: Crop } {
  const width = edges.right - edges.left;
  const height = edges.bottom - edges.top;
  const vx = edges.left / frame.width;
  const vy = edges.top / frame.height;
  const fw = width / frame.width;
  const fh = height / frame.height;
  const crop = normaliseCrop({
    x: item.appearance.flipX ? 1 - vx - fw : vx,
    y: item.appearance.flipY ? 1 - vy - fh : vy,
    width: fw,
    height: fh,
  });
  const c = toWorld(frame, { x: edges.left + width / 2, y: edges.top + height / 2 });
  return { transform: { x: c.x, y: c.y, width, height, rotation: frame.rotation }, crop };
}

/**
 * Slide the original under a fixed window by a world-space drag.
 *
 * The content follows the pointer, so the window moves the other way over the
 * original, and stops where an edge of the original would come into view.
 */
export function slideCrop(item: CanvasItem, worldDelta: Vec2): Crop {
  const frame = cropFrame(item);
  const d = rotate(worldDelta, -frame.rotation);
  const f = visibleFractions(item);
  const fw = f.right - f.left;
  const fh = f.bottom - f.top;
  const vx = clamp(f.left - d.x / frame.width, 0, 1 - fw);
  const vy = clamp(f.top - d.y / frame.height, 0, 1 - fh);
  return normaliseCrop({
    x: item.appearance.flipX ? 1 - vx - fw : vx,
    y: item.appearance.flipY ? 1 - vy - fh : vy,
    width: fw,
    height: fh,
  });
}

/** The whole original again, at the same scale, with what was visible left where it was. */
export function resetCrop(item: CanvasItem): { transform: Transform; crop: Crop } {
  const frame = cropFrame(item);
  return fromEdges(item, frame, { left: 0, top: 0, right: frame.width, bottom: frame.height });
}

/** Which edges a Konva-style anchor name moves (`top-left`, `middle-right`, …). */
export function movingEdges(anchor: string): Moving {
  return {
    left: anchor.includes('left'),
    right: anchor.includes('right'),
    top: anchor.includes('top'),
    bottom: anchor.includes('bottom'),
  };
}
