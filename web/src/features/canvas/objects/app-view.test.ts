import {
  asCanvasId,
  asItemId,
  CanvasDocument,
  type CanvasItem,
  DEFAULT_APPEARANCE,
  FULL_CROP,
} from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { liveApps } from './app-view';

const app = (id: string, x: number, width: number, z = 1, rotation = 0): CanvasItem => ({
  id: asItemId(id),
  transform: { x, y: 0, width, height: 200, rotation },
  z,
  content: { kind: 'app', title: id, html: '<html></html>' },
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
});

const board = (items: CanvasItem[]) => {
  const d = new CanvasDocument(asCanvasId('b'));
  d.loadSnapshot(items, [], 1, []);
  return d;
};
const size = { width: 2000, height: 1000 };

describe('which apps are live (canvas/apps)', () => {
  it('the largest on screen, at most four', () => {
    const d = board([
      app('a1', -800, 300),
      app('a2', -400, 320),
      app('a3', 0, 340),
      app('a4', 400, 360),
      app('a5', 800, 380),
      app('a6', 5000, 600),
    ]);
    expect(liveApps(d, { x: 0, y: 0, zoom: 1 }, size)).toEqual(['a5', 'a4', 'a3', 'a2']);
  });

  it('none too small to read, turned, or under something else', () => {
    const d = board([
      app('small', -600, 300),
      app('turned', 0, 300, 1, 15),
      app('under', 600, 300, 1),
      {
        ...app('note', 600, 100, 2),
        content: { kind: 'note', source: 'over it' },
      },
    ]);
    expect(liveApps(d, { x: 0, y: 0, zoom: 1 }, size)).toEqual(['small']);
    // Zoomed out, 300 world units are 150 px: a card again.
    expect(liveApps(d, { x: 0, y: 0, zoom: 0.5 }, size)).toEqual([]);
  });
});
