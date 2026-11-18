import type { Rect } from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { type AggregateContext, type AggregateStyle, paintAggregate } from './aggregate';

type Call = { op: string; args: number[] };

function fakeContext() {
  const calls: Call[] = [];
  const style: Record<string, unknown> = {};
  const ctx: AggregateContext = {
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    rect: (x, y, w, h) => calls.push({ op: 'rect', args: [x, y, w, h] }),
    fill: () => calls.push({ op: 'fill', args: [] }),
    stroke: () => calls.push({ op: 'stroke', args: [] }),
    set fillStyle(v: string) {
      style.fillStyle = v;
    },
    set strokeStyle(v: string) {
      style.strokeStyle = v;
    },
    set lineWidth(v: number) {
      style.lineWidth = v;
    },
  };
  return { ctx, calls, style, rects: () => calls.filter((c) => c.op === 'rect') };
}

/** Colours are the application's; the painter only has to use what it is given. */
const colors: AggregateStyle = { itemColor: '#ff0000', groupColor: '#00ff00' };

const box = (minX: number, minY: number, size = 100): Rect => ({
  minX,
  minY,
  maxX: minX + size,
  maxY: minY + size,
});

describe('paintAggregate', () => {
  it('marks every item in a single filled path', () => {
    const { ctx, calls, rects } = fakeContext();
    paintAggregate(
      ctx,
      { items: [box(0, 0), box(200, 0), box(400, 0)], groups: [], zoom: 1 },
      colors,
    );

    expect(rects()).toHaveLength(3);
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1);
  });

  it('keeps a mark visible when the item is sub-pixel on screen', () => {
    const { ctx, rects } = fakeContext();
    // A 1-unit item at zoom 0.01 is 0.01 screen px: it must still be drawn.
    paintAggregate(ctx, { items: [box(0, 0, 1)], groups: [], zoom: 0.01 }, colors);

    const [{ args }] = rects() as [Call];
    expect(args[2]).toBeCloseTo(200); // 2 screen px / 0.01 zoom
    expect(args[3]).toBeCloseTo(200);
  });

  it('does not inflate an item that is already large enough', () => {
    const { ctx, rects } = fakeContext();
    paintAggregate(ctx, { items: [box(0, 0, 100)], groups: [], zoom: 1 }, colors);

    const [{ args }] = rects() as [Call];
    expect(args[2]).toBe(100);
  });

  it('outlines groups over their own bounds with a zoom-independent stroke', () => {
    const { ctx, calls, style, rects } = fakeContext();
    paintAggregate(ctx, { items: [box(0, 0)], groups: [box(0, 0, 400)], zoom: 4 }, colors);

    expect(rects()).toHaveLength(2);
    expect(rects()[1]?.args).toEqual([0, 0, 400, 400]);
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1);
    expect(style.lineWidth).toBe(0.25);
  });

  it('draws nothing when there is nothing to aggregate', () => {
    const { ctx, calls } = fakeContext();
    paintAggregate(ctx, { items: [], groups: [], zoom: 1 }, colors);

    expect(calls).toHaveLength(0);
  });
});
