import { describe, expect, it } from 'vitest';
import { CanvasDocument } from './document';
import { rect } from './geometry';
import { asCanvasId, asGroupId, asItemId } from './ids';
import { ItemLod } from './lod';
import { applySelection, expandToGroups, marqueeSelect, selectionBounds } from './selection';
import { computeActiveSet, itemsAtPoint } from './viewport';

const size = { width: 1000, height: 1000 };

/** A grid of `n x n` 100-unit items spaced 200 apart, centred on the origin. */
function grid(n: number): CanvasDocument {
  const d = new CanvasDocument(asCanvasId('grid'));
  const offset = ((n - 1) * 200) / 2;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      d.apply({
        type: 'item.create',
        itemId: asItemId(`i-${row}-${col}`),
        transform: {
          x: col * 200 - offset,
          y: row * 200 - offset,
          width: 100,
          height: 100,
          rotation: 0,
        },
        z: row * n + col,
        content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
      });
    }
  }
  return d;
}

describe('computeActiveSet', () => {
  it('returns far fewer items than the document holds', () => {
    const d = grid(100); // 10,000 items spanning ~20,000 world units
    const active = computeActiveSet(d, { x: 0, y: 0, zoom: 1 }, size);
    expect(d.itemCount).toBe(10_000);
    expect(active.visible.length).toBeLessThan(200);
  });

  it('returns items in painter order', () => {
    const active = computeActiveSet(grid(10), { x: 0, y: 0, zoom: 1 }, size);
    const zs = active.visible.map((v) => v.item.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
  });

  it('preloads beyond the visible rect', () => {
    const d = grid(20);
    const none = computeActiveSet(d, { x: 0, y: 0, zoom: 1 }, size, { preloadMargin: 0 });
    const ring = computeActiveSet(d, { x: 0, y: 0, zoom: 1 }, size, { preloadMargin: 1 });
    expect(ring.visible.length).toBeGreaterThan(none.visible.length);
  });

  it('degrades detail as the camera pulls back', () => {
    const d = grid(40);
    const close = computeActiveSet(d, { x: 0, y: 0, zoom: 10 }, size);
    const far = computeActiveSet(d, { x: 0, y: 0, zoom: 0.02 }, size);
    expect(close.visible.every((v) => v.lod === ItemLod.FULL)).toBe(true);
    expect(far.visible.every((v) => v.lod === ItemLod.MICRO || v.lod === ItemLod.AGGREGATE)).toBe(
      true,
    );
  });

  it('flags truncation instead of flooding the renderer', () => {
    const d = grid(60);
    const active = computeActiveSet(d, { x: 0, y: 0, zoom: 0.02 }, size, { maxItems: 50 });
    expect(active.visible.length).toBe(50);
    expect(active.truncated).toBe(true);
    expect(active.candidateCount).toBeGreaterThan(50);
  });

  it('hands back what it clipped, so nothing has to be looked up twice', () => {
    const d = grid(60);
    const active = computeActiveSet(d, { x: 0, y: 0, zoom: 0.02 }, size, { maxItems: 50 });

    expect(active.overflow.length).toBe(active.candidateCount - 50);
    const shown = new Set(active.visible.map((v) => v.item.id));
    expect(active.overflow.some((id) => shown.has(id))).toBe(false);
  });

  it('reports an empty set for an empty region', () => {
    const active = computeActiveSet(grid(4), { x: 1e6, y: 1e6, zoom: 1 }, size);
    expect(active.visible).toEqual([]);
    expect(active.truncated).toBe(false);
    expect(active.overflow).toEqual([]);
  });
});

describe('itemsAtPoint', () => {
  it('returns topmost first', () => {
    const d = new CanvasDocument(asCanvasId('stack'));
    for (const [id, z] of [
      [asItemId('bottom'), 0],
      [asItemId('top'), 5],
    ] as const) {
      d.apply({
        type: 'item.create',
        itemId: id,
        transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
        z,
        content: { kind: 'placeholder', intrinsicWidth: 1, intrinsicHeight: 1 },
      });
    }
    expect(itemsAtPoint(d, 0, 0)).toEqual([asItemId('top'), asItemId('bottom')]);
  });
});

describe('selection', () => {
  it('replaces, adds and toggles', () => {
    const a = asItemId('a');
    const b = asItemId('b');
    expect(applySelection(new Set([a]), [b], 'replace')).toEqual(new Set([b]));
    expect(applySelection(new Set([a]), [b], 'add')).toEqual(new Set([a, b]));
    expect(applySelection(new Set([a, b]), [b], 'toggle')).toEqual(new Set([a]));
  });

  it('marquee picks up touched items', () => {
    const d = grid(5);
    const hits = marqueeSelect(d, rect(-450, -450, -350, -350));
    expect(hits).toEqual([asItemId('i-0-0')]);
  });

  it('marquee containment mode excludes partially covered items', () => {
    const d = grid(5);
    const clipping = rect(-450, -450, -380, -380); // overlaps but does not enclose
    expect(marqueeSelect(d, clipping)).toHaveLength(1);
    expect(marqueeSelect(d, clipping, { requireContainment: true })).toHaveLength(0);
  });

  it('expands a selection to whole groups', () => {
    const d = grid(3);
    const g = asGroupId('g');
    const members = [asItemId('i-0-0'), asItemId('i-0-1')];
    d.apply({ type: 'group.create', groupId: g, memberIds: members });
    expect(expandToGroups(d, [members[0] as never])).toEqual(new Set(members));
  });

  it('bounds a multi-item selection', () => {
    const d = grid(3);
    expect(selectionBounds(d, [asItemId('i-0-0'), asItemId('i-0-2')])).toEqual(
      rect(-250, -250, 250, -150),
    );
  });

  it('has no bounds for an empty selection', () => {
    expect(selectionBounds(grid(2), [])).toBeUndefined();
  });
});
