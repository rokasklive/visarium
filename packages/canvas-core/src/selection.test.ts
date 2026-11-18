import { describe, expect, it } from 'vitest';
import { CanvasDocument } from './document';
import { type Transform, transformBounds } from './geometry';
import { asCanvasId, asItemId, type ItemId } from './ids';
import type { CanvasOperationBody } from './operations';
import {
  flipSelection,
  MIN_ITEM_SIZE,
  rotateSelection,
  scaleSelection,
  selectionBounds,
  selectionState,
} from './selection';

const at = (x: number, y: number, rotation = 0): Transform => ({
  x,
  y,
  width: 100,
  height: 100,
  rotation,
});

function board(placements: readonly (readonly [string, Transform])[]): {
  doc: CanvasDocument;
  ids: ItemId[];
} {
  const doc = new CanvasDocument(asCanvasId('board-flip'));
  const ids: ItemId[] = [];
  for (const [name, transform] of placements) {
    const itemId = asItemId(name);
    ids.push(itemId);
    doc.apply({
      type: 'item.create',
      itemId,
      transform,
      z: ids.length,
      content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
    });
  }
  return { doc, ids };
}

const applyAll = (doc: CanvasDocument, bodies: readonly CanvasOperationBody[]) => {
  for (const body of bodies) doc.apply(body);
};

const state = (doc: CanvasDocument, ids: readonly ItemId[]) =>
  ids.map((id) => {
    const item = doc.item(id);
    return { transform: item?.transform, appearance: item?.appearance };
  });

describe('flipSelection', () => {
  it('mirrors one rotated item about its own centre', () => {
    const { doc, ids } = board([['a', at(300, 40, 0.6)]]);
    applyAll(doc, flipSelection(doc, ids, 'x'));

    const item = doc.item(ids[0] as ItemId);
    expect(item?.transform.x).toBeCloseTo(300, 9);
    expect(item?.transform.y).toBe(40);
    expect(item?.transform.rotation).toBeCloseTo(-0.6, 12);
    expect(item?.appearance.flipX).toBe(true);
    expect(item?.appearance.flipY).toBe(false);
  });

  it('mirrors an arrangement and leaves the selection bounds alone', () => {
    const { doc, ids } = board([0, 1, 2, 3, 4].map((i) => [`a${i}`, at(i * 200, 0)] as const));
    const before = selectionBounds(doc, ids);
    applyAll(doc, flipSelection(doc, ids, 'x'));

    expect(selectionBounds(doc, ids)).toEqual(before);
    // Leftmost and rightmost have swapped places; the middle one has not moved.
    expect(doc.item(ids[0] as ItemId)?.transform.x).toBeCloseTo(800, 9);
    expect(doc.item(ids[4] as ItemId)?.transform.x).toBeCloseTo(0, 9);
    expect(doc.item(ids[2] as ItemId)?.transform.x).toBeCloseTo(400, 9);
  });

  it('returns every item to where it was when flipped twice', () => {
    const { doc, ids } = board([
      ['a', at(0, 0, 0.3)],
      ['b', at(250, 120, -1.1)],
      ['c', at(-90, 400, 0)],
    ]);
    const before = state(doc, ids);

    applyAll(doc, flipSelection(doc, ids, 'y'));
    applyAll(doc, flipSelection(doc, ids, 'y'));

    for (const [i, id] of ids.entries()) {
      const item = doc.item(id);
      const was = before[i];
      expect(item?.transform.x).toBeCloseTo(was?.transform?.x as number, 9);
      expect(item?.transform.y).toBeCloseTo(was?.transform?.y as number, 9);
      expect(item?.transform.rotation).toBeCloseTo(was?.transform?.rotation as number, 12);
      expect(item?.appearance).toEqual(was?.appearance);
    }
  });

  it('flipping both axes is reflecting through the selection centre', () => {
    const { doc, ids } = board([
      ['a', at(0, 0)],
      ['b', at(400, 200)],
      ['c', at(100, 600)],
    ]);
    const bounds = selectionBounds(doc, ids);
    const cx = ((bounds?.minX as number) + (bounds?.maxX as number)) / 2;
    const cy = ((bounds?.minY as number) + (bounds?.maxY as number)) / 2;
    const before = state(doc, ids);

    applyAll(doc, flipSelection(doc, ids, 'x'));
    applyAll(doc, flipSelection(doc, ids, 'y'));

    for (const [i, id] of ids.entries()) {
      const item = doc.item(id);
      expect(item?.transform.x).toBeCloseTo(2 * cx - (before[i]?.transform?.x as number), 9);
      expect(item?.transform.y).toBeCloseTo(2 * cy - (before[i]?.transform?.y as number), 9);
      expect(item?.appearance.flipX).toBe(true);
      expect(item?.appearance.flipY).toBe(true);
    }
  });

  // The claim the whole one-operation decision rests on: appearance never moves
  // anything, so it never rewrites an index entry. Flipping a single unrotated
  // item is therefore an appearance change and nothing else.
  it('leaves the spatial index untouched when only appearance changes', () => {
    const { doc, ids } = board([['a', at(120, 90)]]);
    const id = ids[0] as ItemId;
    const before = doc.index.boundsOf(id);

    const bodies = flipSelection(doc, ids, 'x');
    expect(bodies).toEqual([
      {
        type: 'item.appearance',
        itemId: id,
        appearance: { opacity: 1, flipX: true, flipY: false },
      },
    ]);
    applyAll(doc, bodies);

    expect(doc.index.boundsOf(id)).toEqual(before);
    expect(doc.index.boundsOf(id)).toMatchObject(transformBounds(at(120, 90)));
  });

  it('produces nothing for an empty selection', () => {
    const { doc } = board([]);
    expect(flipSelection(doc, [], 'x')).toEqual([]);
  });
});

/** A pair 200 apart on the x axis, so the ARRANGEMENT has a size of its own. */
const pair = () =>
  board([
    ['left', at(-100, 0)],
    ['right', at(100, 0)],
  ]);

const transformsOf = (doc: CanvasDocument) => [...doc.items()].map((i) => i.transform);

describe('scaling a selection', () => {
  it('grows the arrangement, not just each item', () => {
    const { doc, ids } = pair();

    for (const body of scaleSelection(doc, ids, 2)) doc.apply(body);

    // The gap doubled along with the items, about the shared centre. Scaling
    // each in place would have grown five images without moving them apart.
    expect(transformsOf(doc).map((t) => t.x)).toEqual([-200, 200]);
    expect(transformsOf(doc).map((t) => t.width)).toEqual([200, 200]);
  });

  it('scales a single item about its own centre, which does not move it', () => {
    const { doc, ids } = board([['only', at(50, 70)]]);

    for (const body of scaleSelection(doc, ids, 3)) doc.apply(body);

    expect(transformsOf(doc)[0]).toMatchObject({ x: 50, y: 70, width: 300, height: 300 });
  });

  it('leaves rotation alone: an angle is not a function of a size', () => {
    const { doc, ids } = board([['turned', at(0, 0, 0.5)]]);

    for (const body of scaleSelection(doc, ids, 2)) doc.apply(body);

    expect(transformsOf(doc)[0]?.rotation).toBe(0.5);
  });

  it('refuses a factor that would take the smallest item below the floor', () => {
    const { doc, ids } = pair();

    // Refused whole, not per item: stopping one member while the rest kept
    // shrinking would rearrange the board behind the person's back.
    expect(scaleSelection(doc, ids, MIN_ITEM_SIZE / 100 / 2)).toEqual([]);
  });

  it('composes, so a gesture of many small factors is their product', () => {
    const once = pair();
    const many = pair();

    for (const body of scaleSelection(once.doc, once.ids, 1.1 ** 10)) once.doc.apply(body);
    for (let i = 0; i < 10; i++) {
      for (const body of scaleSelection(many.doc, many.ids, 1.1)) many.doc.apply(body);
    }

    expect(transformsOf(many.doc)[0]?.width).toBeCloseTo(
      transformsOf(once.doc)[0]?.width as number,
      6,
    );
  });
});

describe('rotating a selection', () => {
  it('turns the arrangement as well as each item', () => {
    const { doc, ids } = pair();

    for (const body of rotateSelection(doc, ids, Math.PI / 2)) doc.apply(body);

    // A quarter turn about the shared centre stands a horizontal pair upright.
    const [left] = transformsOf(doc);
    expect(left?.x).toBeCloseTo(0, 6);
    expect(left?.y).toBeCloseTo(-100, 6);
    expect(left?.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('spins a single item where it stands', () => {
    const { doc, ids } = board([['only', at(40, 40)]]);

    for (const body of rotateSelection(doc, ids, 1)) doc.apply(body);

    expect(transformsOf(doc)[0]?.x).toBeCloseTo(40, 6);
    expect(transformsOf(doc)[0]?.rotation).toBeCloseTo(1, 6);
  });

  it('is nothing at all for no angle', () => {
    const { doc, ids } = pair();
    expect(rotateSelection(doc, ids, 0)).toEqual([]);
  });
});

describe('the state a live gesture has to be able to put back', () => {
  it('replays to exactly where it was taken', () => {
    const { doc, ids } = pair();
    const before = selectionState(doc, ids);

    for (const body of scaleSelection(doc, ids, 4)) doc.apply(body);
    for (const body of rotateSelection(doc, ids, 1.2)) doc.apply(body);
    for (const body of before) doc.apply(body);

    expect(transformsOf(doc)).toEqual([at(-100, 0), at(100, 0)]);
  });

  it('carries appearance too, since a live gesture may fade as well as move', () => {
    const { doc, ids } = board([['only', at(0, 0)]]);

    expect(selectionState(doc, ids).map((b) => b.type)).toEqual([
      'item.transform',
      'item.appearance',
    ]);
  });
});
