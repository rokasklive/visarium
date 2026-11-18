import { describe, expect, it } from 'vitest';
import { gridWindow } from './grid-window';

/**
 * The property that matters is the one M01 established for the canvas: what is
 * instantiated is bounded by the viewport, never by the size of the set.
 */

const base = {
  viewportWidth: 800,
  viewportHeight: 600,
  scrollTop: 0,
  cellSize: 96,
  gap: 8,
  overscanRows: 1,
};

describe('gridWindow', () => {
  it('fits as many whole cells across as the width allows', () => {
    // 7 columns is 7*96 + 6*8 = 720; an eighth would need 824.
    expect(gridWindow({ ...base, count: 100 }).columns).toBe(7);
  });

  it('keeps at least one column in a viewport narrower than a cell', () => {
    // Zero columns divides by zero and renders nothing, which reads as a bug.
    expect(gridWindow({ ...base, count: 10, viewportWidth: 20 }).columns).toBe(1);
  });

  it('sizes the scrollable height to every result, not to what is drawn', () => {
    const view = gridWindow({ ...base, count: 10_000 });
    const rows = Math.ceil(10_000 / view.columns);

    expect(view.totalHeight).toBe(rows * view.rowHeight - base.gap);
    // The scrollbar describes the library; the DOM holds a screenful.
    expect(view.endIndex - view.firstIndex).toBeLessThan(100);
  });

  it('instantiates a bounded window however large the set becomes', () => {
    const sizes = [100, 1_000, 10_000, 100_000];
    const drawn = sizes.map((count) => {
      const view = gridWindow({ ...base, count });
      return view.endIndex - view.firstIndex;
    });

    // A thousand times more assets, the same number of elements.
    expect(new Set(drawn.slice(1)).size).toBe(1);
    expect(Math.max(...drawn)).toBeLessThan(100);
  });

  it('moves the window down as the user scrolls', () => {
    const top = gridWindow({ ...base, count: 10_000 });
    const lower = gridWindow({ ...base, count: 10_000, scrollTop: 5_000 });

    expect(lower.firstIndex).toBeGreaterThan(top.endIndex);
    expect(lower.offsetY).toBeLessThanOrEqual(5_000);
    // The slice is placed where the scrollbar says it is.
    expect(lower.offsetY % lower.rowHeight).toBe(0);
  });

  it('overscans above and below so a fast scroll is not blank', () => {
    const withOverscan = gridWindow({ ...base, count: 10_000, scrollTop: 5_000 });
    const without = gridWindow({ ...base, count: 10_000, scrollTop: 5_000, overscanRows: 0 });

    expect(withOverscan.firstIndex).toBeLessThan(without.firstIndex);
    expect(withOverscan.endIndex).toBeGreaterThan(without.endIndex);
  });

  it('never runs past the end of the set', () => {
    const view = gridWindow({ ...base, count: 3 });

    expect(view.firstIndex).toBe(0);
    expect(view.endIndex).toBe(3);
  });

  it('scrolled to the bottom, ends exactly at the last asset', () => {
    const count = 1_000;
    const full = gridWindow({ ...base, count });
    const view = gridWindow({ ...base, count, scrollTop: full.totalHeight - base.viewportHeight });

    expect(view.endIndex).toBe(count);
  });

  it('has nothing to draw and no height when the library is empty', () => {
    const view = gridWindow({ ...base, count: 0 });

    expect(view.totalHeight).toBe(0);
    expect(view.endIndex).toBe(0);
    expect(view.firstIndex).toBe(0);
  });
});
