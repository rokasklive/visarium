import type { Transform } from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { toStageAttrs } from './stage-camera';
import { bakeScale, fromKonvaAttrs, toKonvaAppearance, toKonvaAttrs } from './transform';

const t: Transform = { x: 100, y: -40, width: 320, height: 180, rotation: Math.PI / 3 };

describe('transform conversion', () => {
  it('round-trips through Konva attributes', () => {
    const back = fromKonvaAttrs(toKonvaAttrs(t));
    expect(back.x).toBeCloseTo(t.x, 9);
    expect(back.y).toBeCloseTo(t.y, 9);
    expect(back.width).toBeCloseTo(t.width, 9);
    expect(back.height).toBeCloseTo(t.height, 9);
    expect(back.rotation).toBeCloseTo(t.rotation, 9);
  });

  it('offsets by half the size so Konva rotates about the centre', () => {
    const attrs = toKonvaAttrs(t);
    expect(attrs.offsetX).toBe(160);
    expect(attrs.offsetY).toBe(90);
    expect(attrs.rotation).toBeCloseTo(60, 9);
  });

  it('bakes Transformer scale into width and height', () => {
    const baked = bakeScale({ ...toKonvaAttrs(t), scaleX: 2, scaleY: 0.5 });
    expect(baked.width).toBe(640);
    expect(baked.height).toBe(90);
  });

  it('treats a mirrored scale as a positive size', () => {
    const baked = bakeScale({ ...toKonvaAttrs(t), scaleX: -1, scaleY: 1 });
    expect(baked.width).toBe(320);
  });

  it('does not let a resize introduce or remove a flip', () => {
    // A handle dragged past its own opposite edge. The size stays positive and
    // the appearance is not consulted, so the item is as flipped as it was.
    const overshot = bakeScale({ ...toKonvaAttrs(t), scaleX: -2, scaleY: -1 });
    expect(overshot.width).toBe(640);
    expect(overshot.height).toBe(180);
    expect(toKonvaAppearance({ opacity: 1, flipX: true, flipY: false }).scaleX).toBe(-1);
  });

  it('leaves nothing for a second bake to do', () => {
    // What a Transformer commit looks like: bake the scale, write the transform
    // back to the node, reset scale to 1. Baking again must be a no-op, or the
    // item grows every time it is touched.
    const once = bakeScale({ ...toKonvaAttrs(t), scaleX: 2, scaleY: 0.5 });
    const twice = bakeScale({ ...toKonvaAttrs(once), scaleX: 1, scaleY: 1 });
    expect(twice).toEqual(once);
  });

  it('re-centres the offset after a resize', () => {
    const baked = bakeScale({ ...toKonvaAttrs(t), scaleX: 2, scaleY: 0.5 });
    const attrs = toKonvaAttrs(baked);
    expect(attrs.offsetX).toBe(baked.width / 2);
    expect(attrs.offsetY).toBe(baked.height / 2);
  });
});

describe('appearance conversion', () => {
  it('passes opacity through untouched', () => {
    expect(toKonvaAppearance({ opacity: 0.35, flipX: false, flipY: false }).opacity).toBe(0.35);
  });

  it('turns each flip into a negative scale on its own axis', () => {
    expect(toKonvaAppearance({ opacity: 1, flipX: true, flipY: false })).toEqual({
      opacity: 1,
      scaleX: -1,
      scaleY: 1,
    });
    expect(toKonvaAppearance({ opacity: 1, flipX: false, flipY: true })).toEqual({
      opacity: 1,
      scaleX: 1,
      scaleY: -1,
    });
  });

  it("mirrors about the item's own centre, because offset is already the half-size", () => {
    // Konva scales about the offset origin. `toKonvaAttrs` puts that at the
    // centre, so a negative scale leaves the node's position — and therefore
    // the item's bounds — exactly where they were.
    const attrs = toKonvaAttrs(t);
    const flipped = { ...attrs, ...toKonvaAppearance({ opacity: 1, flipX: true, flipY: true }) };
    expect(flipped.x).toBe(t.x);
    expect(flipped.y).toBe(t.y);
    expect(flipped.offsetX).toBe(t.width / 2);
    expect(flipped.offsetY).toBe(t.height / 2);
    expect(flipped.width).toBe(t.width);
    expect(flipped.height).toBe(t.height);
  });

  it('is the identity for the default appearance', () => {
    expect(toKonvaAppearance({ opacity: 1, flipX: false, flipY: false })).toEqual({
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
    });
  });
});

describe('stage camera', () => {
  it('puts the camera position at the viewport centre', () => {
    const attrs = toStageAttrs({ x: 50, y: 20, zoom: 2 }, { width: 800, height: 600 });
    expect(attrs).toEqual({ x: 300, y: 260, scaleX: 2, scaleY: 2 });
    // world (50,20) -> 300 + 50*2 = 400 = half of 800. Centred.
  });
});
