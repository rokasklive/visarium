import {
  asAssetId,
  asCanvasId,
  asItemId,
  CanvasDocument,
  CanvasHistory,
  type CanvasItemContent,
  type CanvasOperationBody,
  newGroupId,
} from '@visarium/canvas-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardSync, type OperationPoster, type PostResult, SyncError } from './board-sync';

const FLUSH = 10;

const transform = (x: number) => ({ x, y: 0, width: 100, height: 80, rotation: 0 });

const image = (id = 'asset-1'): CanvasItemContent => ({
  kind: 'image',
  asset: { assetId: asAssetId(id), intrinsicWidth: 1600, intrinsicHeight: 1200 },
});

const placeholder: CanvasItemContent = {
  kind: 'placeholder',
  intrinsicWidth: 1600,
  intrinsicHeight: 1200,
};

const create = (id: string, content: CanvasItemContent, x = 0): CanvasOperationBody => ({
  type: 'item.create',
  itemId: asItemId(id),
  transform: transform(x),
  z: 1,
  content,
});

/** A poster the test drives, recording every batch it is handed. */
function recorder(
  behaviour: (batch: readonly CanvasOperationBody[]) => Promise<number> = async () => 1,
) {
  const batches: CanvasOperationBody[][] = [];
  const post: OperationPoster = vi.fn(async (_board, operations) => {
    batches.push([...operations]);
    return behaviour(operations);
  });
  return { post, batches };
}

function sync(post: OperationPoster, doc = new CanvasDocument(asCanvasId('b'))) {
  const board = new BoardSync({ boardId: 'board-1', doc, post, flushMs: FLUSH });
  doc.onApplied(board.applied);
  return { board, doc };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let the flush timer fire and its promise settle. */
async function settle(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(FLUSH);
  }
}

describe('board sync', () => {
  it('sends what was applied, once the window closes', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);

    doc.apply(create('i1', image()));
    expect(post).not.toHaveBeenCalled();

    await settle();
    expect(batches).toEqual([[create('i1', image())]]);
  });

  it('sends a framing toggle through the same funnel as everything else', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);
    const groupId = newGroupId();
    doc.apply({ type: 'group.create', groupId, memberIds: [asItemId('i1')] });

    await settle();
    doc.apply({ type: 'group.frame', groupId, frame: true });
    await settle();

    expect(batches[1]).toEqual([{ type: 'group.frame', groupId, frame: true }]);
    // And the inverse rides the same funnel, which is what makes undo durable.
    doc.apply({ type: 'group.frame', groupId, frame: false });
    await settle();
    expect(batches[2]).toEqual([{ type: 'group.frame', groupId, frame: false }]);
  });

  it('turns one gesture into one request', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);
    doc.apply(create('i1', image()));

    await settle();
    for (let i = 0; i < 5; i += 1) {
      doc.apply({ type: 'item.transform', itemId: asItemId('i1'), transform: transform(i) });
    }
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(batches[1]).toHaveLength(5);
  });

  it('carries undo and redo, because they go through the same funnel', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);
    const history = new CanvasHistory(doc);

    history.apply(create('i1', image()));
    history.undo();
    history.redo();
    await settle();

    expect(batches.flat().map((body) => body.type)).toEqual([
      'item.create',
      'item.delete',
      'item.create',
    ]);
  });

  it('sends nothing for an operation that changed nothing', async () => {
    const { post } = recorder();
    const { doc } = sync(post);

    doc.apply({ type: 'item.delete', itemId: asItemId('never-existed') });
    await settle();

    expect(post).not.toHaveBeenCalled();
  });

  it('records the revision the server reached', async () => {
    const { post } = recorder(async () => 42);
    const { doc } = sync(post);

    doc.apply(create('i1', image()));
    await settle();

    expect(doc.revision).toBe(42);
  });

  // --- deferral ------------------------------------------------------------

  it('does not send an item the server cannot hold', async () => {
    const { post } = recorder();
    const { doc } = sync(post);

    doc.apply(create('dropped', placeholder));
    doc.apply({ type: 'item.transform', itemId: asItemId('dropped'), transform: transform(999) });
    await settle();

    expect(post).not.toHaveBeenCalled();
  });

  it('creates the deferred item once its upload resolves, where it now is', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);

    doc.apply(create('dropped', placeholder));
    doc.apply({ type: 'item.transform', itemId: asItemId('dropped'), transform: transform(640) });
    doc.apply({ type: 'item.z', itemId: asItemId('dropped'), z: 77 });
    doc.apply({ type: 'item.content', itemId: asItemId('dropped'), content: image('a9') });
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    const [body] = batches[0] as [CanvasOperationBody];
    expect(body.type).toBe('item.create');
    // The state at resolution, not at the drop: it was draggable all along.
    expect(body).toMatchObject({ transform: transform(640), z: 77, content: image('a9') });
  });

  /*
   * The third of appearance's five paths, and one of the two that fail
   * silently: `#durable` rebuilds the deferred creation field by field from the
   * live document, so a field it does not name is a field a still-uploading
   * item loses with no error anywhere.
   */
  it('carries an appearance set while the image was still uploading', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);

    doc.apply(create('dropped', placeholder));
    doc.apply({
      type: 'item.appearance',
      itemId: asItemId('dropped'),
      appearance: { opacity: 0.3, flipX: false, flipY: true },
    });
    doc.apply({ type: 'item.content', itemId: asItemId('dropped'), content: image('a9') });
    await settle();

    // Two operations were applied to a deferred item and neither was sent on its
    // own: the creation carries the result of all of it.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]?.[0]).toMatchObject({
      type: 'item.create',
      appearance: { opacity: 0.3, flipX: false, flipY: true },
    });
  });

  it('sends nothing at all for an item deleted before its upload landed', async () => {
    const { post } = recorder();
    const { doc } = sync(post);

    doc.apply(create('dropped', placeholder));
    doc.apply({ type: 'item.delete', itemId: asItemId('dropped') });
    await settle();

    expect(post).not.toHaveBeenCalled();
  });

  // --- failure -------------------------------------------------------------

  it('keeps failing operations queued, in order', async () => {
    let fail = true;
    const { post, batches } = recorder(async () => {
      if (fail) throw new SyncError('server down', 503);
      return 7;
    });
    const { doc, board } = sync(post);

    doc.apply(create('i1', image(), 1));
    await settle();
    expect(board.status.pending).toBe(1);

    doc.apply(create('i2', image(), 2));
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);

    // Both operations arrive, and the one applied first arrives first.
    const sent = batches.at(-1) as CanvasOperationBody[];
    expect(sent.map((body) => 'itemId' in body && body.itemId)).toEqual(['i1', 'i2']);
    expect(board.status.pending).toBe(0);
    expect(doc.revision).toBe(7);
  });

  it('says so when persisting keeps failing', async () => {
    const { post } = recorder(async () => {
      throw new SyncError('server down', 503);
    });
    const { doc, board } = sync(post);

    doc.apply(create('i1', image()));
    await vi.advanceTimersByTimeAsync(5000);

    expect(board.status.failing).toBe(true);
    expect(board.status.pending).toBe(1);
  });

  it('drops a batch the server has refused rather than retrying it forever', async () => {
    const { post } = recorder(async () => {
      throw new SyncError('not an image', 400);
    });
    const { doc, board } = sync(post);

    doc.apply(create('i1', image()));
    await vi.advanceTimersByTimeAsync(5000);

    expect(post).toHaveBeenCalledTimes(1);
    expect(board.status.pending).toBe(0);
    expect(board.status.failing).toBe(true);
  });

  it('never makes the caller wait', () => {
    const { post } = recorder(() => new Promise(() => {}));
    const { doc } = sync(post);

    // `apply` is synchronous and stays synchronous: invariant 6 is about this.
    expect(doc.apply(create('i1', image()))).toBeDefined();
  });
});

describe('the signal locks wait on', () => {
  it('is already settled when nothing is queued', async () => {
    const { post } = recorder();
    const { board } = sync(post);
    await expect(board.settled()).resolves.toBeUndefined();
  });

  it('does not settle until the batch has actually been posted', async () => {
    const { post } = recorder();
    const { board, doc } = sync(post);
    let settled = false;
    doc.apply(create('i1', image()));
    void board.settled().then(() => {
      settled = true;
    });

    // Queued but not sent. This is the window in which the item's committed
    // state is still the old one, and letting go of the lock here is exactly
    // what would let someone else's edit be overwritten.
    await Promise.resolve();
    expect(settled).toBe(false);

    await settle();
    expect(settled).toBe(true);
  });

  it('stays unsettled while persistence is failing, so the claim is held', async () => {
    let attempts = 0;
    const { post } = recorder(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('offline');
      return 1;
    });
    const { board, doc } = sync(post);
    let settled = false;
    doc.apply(create('i1', image()));
    void board.settled().then(() => {
      settled = true;
    });

    await settle();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The ~10 s lock expiry is the backstop for this: an item briefly
    // ungrabbable beats an edit quietly lost.
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe('remote operations', () => {
  it('are not echoed back to the server', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);

    doc.apply(create('i1', image()), 'remote');
    await settle();

    expect(batches).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('do not stop local edits from being sent', async () => {
    const { post, batches } = recorder();
    const { doc } = sync(post);

    doc.apply(create('i1', image()), 'remote');
    doc.apply(create('i2', image(), 50));
    await settle();

    expect(batches.flat()).toEqual([create('i2', image(), 50)]);
  });

  it('does not bump the revision twice for one change', async () => {
    const { post } = recorder();
    const { doc } = sync(post);

    // The server already counted this operation when it committed it; sending
    // it back would advance the board a second time for a single edit.
    doc.apply(create('i1', image()), 'remote');
    await settle();

    expect(post).not.toHaveBeenCalled();
  });
});

describe('operations the server appended', () => {
  const push = (id: string, x: number): CanvasOperationBody => ({
    type: 'item.transform',
    itemId: asItemId(id),
    transform: transform(x),
  });

  it('applies a push the server added to a batch, off the undo stack and never posted back', async () => {
    const doc = new CanvasDocument(asCanvasId('b'));
    const history = new CanvasHistory(doc);
    let calls = 0;
    const batches: CanvasOperationBody[][] = [];
    const post: OperationPoster = vi.fn(async (_board, operations) => {
      batches.push([...operations]);
      calls += 1;
      return calls === 2 ? { revision: 4, pushed: [push('i2', 500)] } : calls + 1;
    });
    const redraws = vi.fn();
    const board = new BoardSync({
      boardId: 'b',
      doc,
      post,
      flushMs: FLUSH,
      onRemoteChange: redraws,
    });
    doc.onApplied(board.applied);
    history.apply(create('i1', image()), create('i2', image(), 200));
    await settle();

    // The person widens i1 over i2; the server pushes i2 aside.
    history.apply({
      type: 'item.transform',
      itemId: asItemId('i1'),
      transform: { ...transform(0), width: 400 },
    });
    await settle();
    expect(doc.item(asItemId('i2'))?.transform.x).toBe(500);
    expect(doc.revision).toBe(4);
    expect(redraws).toHaveBeenCalledTimes(1);

    // Undo returns i1 to its size and leaves i2 where it was pushed.
    history.undo();
    expect(doc.item(asItemId('i1'))?.transform.width).toBe(100);
    expect(doc.item(asItemId('i2'))?.transform.x).toBe(500);
    await settle();
    expect(batches.flat().some((b) => b.type === 'item.transform' && b.itemId === 'i2')).toBe(
      false,
    );
  });

  it('keeps a newer local edit over a push for the same item', async () => {
    let release: (v: { revision: number; pushed: CanvasOperationBody[] }) => void = () => {};
    const post: OperationPoster = vi.fn(
      () =>
        new Promise<PostResult>((resolve) => {
          release = resolve;
        }),
    );
    const { doc } = sync(post);
    doc.apply(create('i1', image()));
    await settle();
    // While the batch is out, the person moves i1 again.
    doc.apply(push('i1', 900));
    release({ revision: 2, pushed: [push('i1', 300)] });
    await settle();
    expect(doc.item(asItemId('i1'))?.transform.x).toBe(900);
  });
});
