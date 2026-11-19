import { describe, expect, it } from 'vitest';
import { CanvasDocument } from './document';
import { transformBounds } from './geometry';
import { CanvasHistory } from './history';
import { asCanvasId, asItemId } from './ids';
import type { CanvasOperationBody } from './operations';

const A = asItemId('item-a');
const B = asItemId('item-b');

const at = (x: number, y: number) => ({ x, y, width: 100, height: 100, rotation: 0 });

const create = (id = A, x = 0, y = 0): CanvasOperationBody => ({
  type: 'item.create',
  itemId: id,
  transform: at(x, y),
  z: 0,
  content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
});

const move = (id: typeof A, x: number, y: number): CanvasOperationBody => ({
  type: 'item.transform',
  itemId: id,
  transform: at(x, y),
});

function board() {
  const doc = new CanvasDocument(asCanvasId('board'));
  const history = new CanvasHistory(doc);
  history.apply(create(A, 0, 0), create(B, 500, 0));
  return { doc, history };
}

describe('undo', () => {
  it('turns collision back off for a multi-item toggle as one step', () => {
    const { doc, history } = board();
    history.apply(
      { type: 'item.collides', itemId: A, collides: true },
      { type: 'item.collides', itemId: B, collides: true },
    );
    expect([doc.item(A)?.collides, doc.item(B)?.collides]).toEqual([true, true]);
    expect(history.undo()).toBe(true);
    expect([doc.item(A)?.collides, doc.item(B)?.collides]).toEqual([false, false]);
  });

  it('restores the previous transform, index included', () => {
    const { doc, history } = board();
    history.apply(move(A, 300, 300));
    expect(doc.item(A)?.transform.x).toBe(300);

    expect(history.undo()).toBe(true);
    expect(doc.item(A)?.transform).toEqual(at(0, 0));
    expect(doc.index.search(transformBounds(at(0, 0)))).toContain(A);
    expect(doc.index.search(transformBounds(at(300, 300)))).not.toContain(A);
  });

  it('treats one gesture over many items as one step', () => {
    const { doc, history } = board();
    const before = history.depth;
    history.apply(move(A, 10, 10), move(B, 510, 10));

    expect(history.depth).toBe(before + 1);
    history.undo();
    expect(doc.item(A)?.transform).toEqual(at(0, 0));
    expect(doc.item(B)?.transform).toEqual(at(500, 0));
  });

  it('is a no-op on an empty stack', () => {
    const doc = new CanvasDocument(asCanvasId('board'));
    expect(new CanvasHistory(doc).undo()).toBe(false);
  });
});

describe('redo', () => {
  it('reapplies what undo took back', () => {
    const { doc, history } = board();
    history.apply(move(A, 300, 300));
    history.undo();

    expect(history.canRedo).toBe(true);
    expect(history.redo()).toBe(true);
    expect(doc.item(A)?.transform).toEqual(at(300, 300));
    expect(history.canUndo).toBe(true);
  });

  it('is invalidated by a new edit', () => {
    const { history } = board();
    history.apply(move(A, 300, 300));
    history.undo();
    history.apply(move(B, 10, 10));

    expect(history.canRedo).toBe(false);
  });

  it('survives a rejected new edit', () => {
    const { history } = board();
    history.apply(move(A, 300, 300));
    history.undo();
    history.apply(move(asItemId('ghost'), 1, 1));

    expect(history.canRedo).toBe(true);
  });
});

describe('operations that changed nothing', () => {
  it('take no undo slot', () => {
    const { history } = board();
    const before = history.depth;

    expect(history.apply(move(asItemId('ghost'), 1, 1))).toBe(false);
    expect(history.depth).toBe(before);
  });

  it('do not stop the rest of the gesture from being recorded', () => {
    const { doc, history } = board();
    history.apply(move(asItemId('ghost'), 1, 1), move(A, 42, 42));

    history.undo();
    expect(doc.item(A)?.transform).toEqual(at(0, 0));
  });
});

describe('clear', () => {
  it('drops both stacks', () => {
    const { history } = board();
    history.apply(move(A, 1, 1));
    history.undo();
    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
