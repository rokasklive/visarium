import { asAssetId, asCanvasId, asItemId, CanvasDocument } from '@visarium/canvas-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoardSync, flushAll, SyncError } from './board-sync';

// Its own file: `flushAll` sees every queue the module has made.

const create = (id: string) =>
  ({
    type: 'item.create',
    itemId: asItemId(id),
    transform: { x: 0, y: 0, width: 100, height: 80, rotation: 0 },
    z: 1,
    content: {
      kind: 'image',
      asset: { assetId: asAssetId('a'), intrinsicWidth: 10, intrinsicHeight: 10 },
    },
  }) as const;

function board(post: () => Promise<number>) {
  const doc = new CanvasDocument(asCanvasId('b'));
  const sync = new BoardSync({ boardId: 'b', doc, post, flushMs: 60_000 });
  doc.onApplied(sync.applied);
  return { doc, sync };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('sends every board at once and says when nothing is left', async () => {
  const one = board(async () => 1);
  const two = board(async () => 1);
  one.doc.apply(create('i1'));
  two.doc.apply(create('i2'));

  expect(await flushAll(1000)).toEqual({ pending: 0, failing: false });
  one.sync.stop();
  two.sync.stop();
});

it('reports edits the server keeps refusing, after the wait', async () => {
  const down = board(async () => {
    throw new SyncError('down', 503);
  });
  down.doc.apply(create('i3'));

  const answer = flushAll(1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await answer).pending).toBeGreaterThan(0);
  down.sync.stop();
});

it('forgets a stopped board', async () => {
  const gone = board(async () => {
    throw new SyncError('down', 503);
  });
  gone.doc.apply(create('i4'));
  gone.sync.stop();
  expect(await flushAll(10)).toEqual({ pending: 0, failing: false });
});
