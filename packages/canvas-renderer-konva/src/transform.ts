/**
 * The conversion that keeps Konva out of the domain model.
 *
 * canvas-core places items by CENTRE and rotates about that centre, in radians.
 * Konva positions nodes by their `offset` origin (top-left by default) and
 * rotates in degrees. Rather than bend the domain to the renderer, the whole
 * mismatch is absorbed here, in about forty lines.
 *
 * If Konva is ever replaced, this file is the shape of the work.
 */

import { type Appearance, type Crop, isFullCrop, type Transform } from '@visarium/canvas-core';

/** Konva node attributes: position, size, and rotation in degrees. */
export interface KonvaNodeAttrs {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Setting `offset` to the half-size makes Konva rotate about the centre, so the
 * node's `x`/`y` can stay the domain's centre coordinates and no arithmetic is
 * needed on every frame.
 */
export function toKonvaAttrs(t: Transform): KonvaNodeAttrs {
  return {
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    rotation: t.rotation * RAD_TO_DEG,
    offsetX: t.width / 2,
    offsetY: t.height / 2,
  };
}

/** Konva node attributes carrying an item's appearance rather than its place. */
export interface KonvaAppearanceAttrs {
  opacity: number;
  scaleX: number;
  scaleY: number;
}

/**
 * A flip is a boolean in the domain and a negative scale in Konva. That
 * sentence is the whole renderer boundary for appearance.
 *
 * The mirror is about the CENTRE for free: `toKonvaAttrs` already sets `offset`
 * to the half-size, and Konva scales about the offset origin. So rotation and
 * flip compose correctly with nothing else changing.
 */
export function toKonvaAppearance(appearance: Appearance): KonvaAppearanceAttrs {
  return {
    opacity: appearance.opacity,
    scaleX: appearance.flipX ? -1 : 1,
    scaleY: appearance.flipY ? -1 : 1,
  };
}

/** Konva's image crop, in the pixels of whichever bitmap is drawn. */
export interface KonvaCropAttrs {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/**
 * A crop is a fraction of the original in the domain and bitmap pixels in
 * Konva, because the bitmap drawn is one of several derivatives (ADR-0029).
 *
 * The whole image is all zeros, which is Konva's own "no crop": it then draws
 * with the three-argument `drawImage` exactly as before crop existed, so an
 * uncropped item takes the same path it always did. Flip needs nothing here —
 * Konva crops the source first and mirrors the result with the node's scale.
 */
export function toKonvaCrop(crop: Crop, image: { width: number; height: number }): KonvaCropAttrs {
  if (isFullCrop(crop)) return { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0 };
  return {
    cropX: crop.x * image.width,
    cropY: crop.y * image.height,
    cropWidth: crop.width * image.width,
    cropHeight: crop.height * image.height,
  };
}

/** The reverse, for reading a transform back off a node after a Konva drag. */
export function fromKonvaAttrs(attrs: KonvaNodeAttrs): Transform {
  return {
    x: attrs.x,
    y: attrs.y,
    width: attrs.width,
    height: attrs.height,
    rotation: attrs.rotation * DEG_TO_RAD,
  };
}

/**
 * Konva's Transformer reports resizes as scale rather than size. Baking scale
 * into width/height keeps the domain free of a second sizing concept, and keeps
 * stroke widths and text from scaling with the box.
 *
 * `Math.abs` stays, and now for a second reason as well as the first. The first
 * is that a size is a size — `CHECK (width > 0)`, `transformBounds` and every
 * comparison in the codebase assume it. The second is that **a flip must not
 * arrive by accident**: dragging a resize handle past its own opposite edge
 * would otherwise mirror the image, and flipping is a deliberate act with a key
 * and a button. The node's own `scaleX`/`scaleY` are re-derived from the item's
 * appearance on the next render whatever `onTransformEnd` left on them, so the
 * sign discarded here is not information anything downstream wanted.
 */
export function bakeScale(attrs: KonvaNodeAttrs & { scaleX: number; scaleY: number }): Transform {
  return {
    x: attrs.x,
    y: attrs.y,
    width: Math.abs(attrs.width * attrs.scaleX),
    height: Math.abs(attrs.height * attrs.scaleY),
    rotation: attrs.rotation * DEG_TO_RAD,
  };
}
