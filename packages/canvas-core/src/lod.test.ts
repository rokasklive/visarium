import { describe, expect, it } from 'vitest';
import { DERIVATIVE_WIDTHS, ItemLod, pickDerivative, projectedSize, resolveLod } from './lod';

const item = (size: number) => ({ x: 0, y: 0, width: size, height: size, rotation: 0 });

describe('resolveLod', () => {
  it('walks down the ladder as zoom decreases', () => {
    const t = item(1024);
    expect(resolveLod(t, 1)).toBe(ItemLod.FULL);
    expect(resolveLod(t, 0.5)).toBe(ItemLod.PREVIEW);
    expect(resolveLod(t, 0.1)).toBe(ItemLod.THUMBNAIL);
    expect(resolveLod(t, 0.02)).toBe(ItemLod.MICRO);
    expect(resolveLod(t, 0.002)).toBe(ItemLod.AGGREGATE);
  });

  it('is monotonic: zooming in never lowers the detail level', () => {
    const order = [
      ItemLod.AGGREGATE,
      ItemLod.MICRO,
      ItemLod.THUMBNAIL,
      ItemLod.PREVIEW,
      ItemLod.FULL,
    ] as const;
    const t = item(512);
    let previous = -1;
    for (const zoom of [0.001, 0.01, 0.05, 0.2, 0.5, 1, 4]) {
      const rank = order.indexOf(resolveLod(t, zoom) as (typeof order)[number]);
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it('uses the longest edge, so a wide thin item is not under-detailed', () => {
    expect(projectedSize({ x: 0, y: 0, width: 4000, height: 10, rotation: 0 }, 0.1)).toBe(400);
  });
});

describe('pickDerivative', () => {
  it('picks the smallest derivative that still covers the request', () => {
    expect(pickDerivative(50)).toBe(64);
    expect(pickDerivative(64)).toBe(64);
    expect(pickDerivative(65)).toBe(256);
    expect(pickDerivative(1000)).toBe(1024);
    expect(pickDerivative(2048)).toBe(2048);
  });

  it('falls back to the original past the largest derivative', () => {
    expect(pickDerivative(4000)).toBe('original');
  });

  it('never returns a derivative narrower than requested', () => {
    for (let w = 1; w <= 2048; w += 7) {
      const chosen = pickDerivative(w);
      if (chosen !== 'original') expect(chosen).toBeGreaterThanOrEqual(w);
    }
  });

  it('keeps derivative widths sorted descending', () => {
    expect([...DERIVATIVE_WIDTHS]).toEqual([...DERIVATIVE_WIDTHS].sort((a, b) => b - a));
  });
});
