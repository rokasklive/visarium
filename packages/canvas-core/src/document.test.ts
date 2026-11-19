import { describe, expect, it } from 'vitest';
import { CanvasDocument } from './document';
import { transformBounds } from './geometry';
import { asCanvasId, asGroupId, asItemId } from './ids';
import { type CanvasItem, DEFAULT_APPEARANCE, FULL_CROP } from './model';
import type { CanvasOperationBody } from './operations';

const canvasId = asCanvasId('board-1');
const A = asItemId('item-a');
const B = asItemId('item-b');
const G = asGroupId('group-1');

const at = (x: number, y: number) => ({ x, y, width: 100, height: 100, rotation: 0 });

const create = (id = A, x = 0, y = 0, z = 0): CanvasOperationBody => ({
  type: 'item.create',
  itemId: id,
  transform: at(x, y),
  z,
  content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
});

const doc = () => new CanvasDocument(canvasId);

describe('applying operations', () => {
  it('creates an item and indexes it', () => {
    const d = doc();
    d.apply(create());
    expect(d.itemCount).toBe(1);
    expect(d.index.search(transformBounds(at(0, 0)))).toEqual([A]);
  });

  it('ignores a duplicate create', () => {
    const d = doc();
    d.apply(create());
    expect(d.apply(create())).toBeUndefined();
    expect(d.itemCount).toBe(1);
  });

  it('ignores an operation on an unknown item rather than throwing', () => {
    const d = doc();
    expect(d.apply({ type: 'item.transform', itemId: A, transform: at(5, 5) })).toBeUndefined();
    expect(d.apply({ type: 'item.delete', itemId: A })).toBeUndefined();
  });

  it('keeps the spatial index in step with transforms', () => {
    const d = doc();
    d.apply(create());
    d.apply({ type: 'item.transform', itemId: A, transform: at(5000, 5000) });
    expect(d.index.search(transformBounds(at(0, 0)))).toEqual([]);
    expect(d.index.search(transformBounds(at(5000, 5000)))).toEqual([A]);
  });

  it('removes deleted items from the index', () => {
    const d = doc();
    d.apply(create());
    d.apply({ type: 'item.delete', itemId: A });
    expect(d.index.size).toBe(0);
  });
});

describe('inverses', () => {
  const roundTrip = (setup: (d: CanvasDocument) => void, op: CanvasOperationBody) => {
    const d = doc();
    setup(d);
    const before = snapshot(d);
    const inverse = d.apply(op);
    expect(inverse, 'operation produced no inverse').toBeDefined();
    d.apply(inverse as CanvasOperationBody);
    expect(snapshot(d)).toEqual(before);
  };

  it('undoes a create', () => roundTrip(() => {}, create()));

  it('undoes a delete', () =>
    roundTrip((d) => d.apply(create()), { type: 'item.delete', itemId: A }));

  it('undoes a transform', () =>
    roundTrip((d) => d.apply(create()), {
      type: 'item.transform',
      itemId: A,
      transform: { x: 9, y: 9, width: 3, height: 4, rotation: 1 },
    }));

  it('undoes a z change', () =>
    roundTrip((d) => d.apply(create()), { type: 'item.z', itemId: A, z: 42 }));

  it('undoes a group create', () =>
    roundTrip(
      (d) => {
        d.apply(create(A));
        d.apply(create(B, 200, 0));
      },
      { type: 'group.create', groupId: G, memberIds: [A, B] },
    ));

  it('undoes an appearance change, flips included', () =>
    roundTrip(
      (d) => {
        d.apply(create());
        d.apply({
          type: 'item.appearance',
          itemId: A,
          appearance: { opacity: 0.4, flipX: true, flipY: false },
        });
      },
      {
        type: 'item.appearance',
        itemId: A,
        appearance: { opacity: 1, flipX: false, flipY: true },
      },
    ));

  it('undoes a group label', () =>
    roundTrip(
      (d) => {
        d.apply(create(A));
        d.apply({ type: 'group.create', groupId: G, memberIds: [A], label: 'moodboard' });
      },
      { type: 'group.label', groupId: G, label: 'renamed' },
    ));

  it('undoes a group membership change', () =>
    roundTrip(
      (d) => {
        d.apply(create(A));
        d.apply(create(B, 200, 0));
        d.apply({ type: 'group.create', groupId: G, memberIds: [A] });
      },
      { type: 'group.members', groupId: G, memberIds: [A, B] },
    ));
});

describe('appearance', () => {
  const faded = { opacity: 0.3, flipX: false, flipY: true } as const;

  it('defaults to opaque and unflipped when a creation carries none', () => {
    const d = doc();
    d.apply(create());
    expect(d.item(A)?.appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it('lands the same item when applied twice', () => {
    const d = doc();
    d.apply(create());
    d.apply({ type: 'item.appearance', itemId: A, appearance: faded });
    const { revision: _, ...once } = d.item(A) as CanvasItem;
    d.apply({ type: 'item.appearance', itemId: A, appearance: faded });
    const { revision: __, ...twice } = d.item(A) as CanvasItem;
    expect(twice).toEqual(once);
  });

  it('does not move an item, so the index is untouched', () => {
    const d = doc();
    d.apply(create());
    const before = d.index.boundsOf(A);
    d.apply({
      type: 'item.appearance',
      itemId: A,
      appearance: { opacity: 0.5, flipX: true, flipY: true },
    });
    expect(d.index.boundsOf(A)).toEqual(before);
    expect(d.item(A)?.transform).toEqual(at(0, 0));
  });

  // The literal in `item.delete`'s inverse is rebuilt field by field, so a
  // missing appearance there fails silently rather than loudly.
  it('restores a set appearance when a delete is undone', () => {
    const d = doc();
    d.apply(create());
    d.apply({ type: 'item.appearance', itemId: A, appearance: faded });
    const inverse = d.apply({ type: 'item.delete', itemId: A });
    d.apply(inverse as CanvasOperationBody);
    expect(d.item(A)?.appearance).toEqual(faded);
  });

  it('takes no undo slot for an unknown item', () => {
    const d = doc();
    expect(d.apply({ type: 'item.appearance', itemId: A, appearance: faded })).toBeUndefined();
    expect(d.apply({ type: 'group.label', groupId: G, label: 'x' })).toBeUndefined();
  });
});

describe('crop', () => {
  const half = { x: 0.5, y: 0, width: 0.5, height: 1 };

  it('creates uncropped unless told otherwise', () => {
    const d = doc();
    d.apply(create());
    expect(d.item(A)?.crop).toEqual(FULL_CROP);
    d.apply({ ...create(B), crop: half } as CanvasOperationBody);
    expect(d.item(B)?.crop).toEqual(half);
  });

  it('undoes a crop and its box together, in one inverse', () => {
    const d = doc();
    d.apply(create());
    const inverse = d.apply({
      type: 'item.transform',
      itemId: A,
      transform: { ...at(25, 0), width: 50 },
      crop: half,
    });
    expect(d.item(A)?.crop).toEqual(half);
    expect(inverse).toEqual({
      type: 'item.transform',
      itemId: A,
      transform: at(0, 0),
      crop: FULL_CROP,
    });
    d.apply(inverse as CanvasOperationBody);
    expect(d.item(A)?.transform).toEqual(at(0, 0));
    expect(d.item(A)?.crop).toEqual(FULL_CROP);
  });

  it('leaves a crop alone on a plain move, and its undo does not name one', () => {
    const d = doc();
    d.apply({ ...create(), crop: half } as CanvasOperationBody);
    const inverse = d.apply({ type: 'item.transform', itemId: A, transform: at(9, 9) });
    expect(d.item(A)?.crop).toEqual(half);
    expect(inverse).toEqual({ type: 'item.transform', itemId: A, transform: at(0, 0) });
  });

  it('brings a crop back with delete-then-undo', () => {
    const d = doc();
    d.apply({ ...create(), crop: half } as CanvasOperationBody);
    const inverse = d.apply({ type: 'item.delete', itemId: A }) as CanvasOperationBody;
    d.apply(inverse);
    expect(d.item(A)?.crop).toEqual(half);
  });
});

describe('groups', () => {
  it('stamps and clears membership on its items', () => {
    const d = doc();
    d.apply(create(A));
    d.apply(create(B, 200, 0));
    d.apply({ type: 'group.create', groupId: G, memberIds: [A, B] });
    expect(d.item(A)?.groupId).toBe(G);

    d.apply({ type: 'group.delete', groupId: G });
    expect(d.item(A)?.groupId).toBeUndefined();
    expect(d.groupCount).toBe(0);
  });

  it('renames a group without disturbing its membership', () => {
    const d = doc();
    d.apply(create(A));
    d.apply(create(B, 200, 0));
    d.apply({ type: 'group.create', groupId: G, memberIds: [A, B], label: 'first' });
    d.apply({ type: 'group.label', groupId: G, label: 'second' });
    expect(d.group(G)?.label).toBe('second');
    expect(d.group(G)?.memberIds).toEqual([A, B]);
  });

  it('frames and unframes a group, inverting to absolute state', () => {
    const d = doc();
    d.apply(create(A));
    d.apply({ type: 'group.create', groupId: G, memberIds: [A] });
    expect(d.group(G)?.frame).toBeUndefined();

    expect(d.apply({ type: 'group.frame', groupId: G, frame: true })).toEqual({
      type: 'group.frame',
      groupId: G,
      frame: false,
    });
    expect(d.group(G)?.frame).toBe(true);

    // Undo of the framing is the inverse just returned; undo again (the
    // `frame: false` applied to an unframed group) is a no-op worth nothing.
    d.apply({ type: 'group.frame', groupId: G, frame: false });
    expect(d.apply({ type: 'group.frame', groupId: G, frame: false })).toEqual({
      type: 'group.frame',
      groupId: G,
      frame: false,
    });
  });

  it('carries the frame through create/delete inverses and survives unknown targets', () => {
    const d = doc();
    d.apply(create(A));
    d.apply({ type: 'group.create', groupId: G, memberIds: [A], label: 'x', frame: true });
    expect(d.group(G)?.frame).toBe(true);

    const inverse = d.apply({ type: 'group.delete', groupId: G });
    expect(inverse).toMatchObject({ type: 'group.create', frame: true });

    // Unknown group: a benign race, not an error.
    expect(
      d.apply({ type: 'group.frame', groupId: asGroupId('group-unknown'), frame: true }),
    ).toBeUndefined();
  });

  it('reports bounds spanning its members', () => {
    const d = doc();
    d.apply(create(A, 0, 0));
    d.apply(create(B, 200, 0));
    d.apply({ type: 'group.create', groupId: G, memberIds: [A, B] });
    expect(d.groupBounds(G)).toEqual({ minX: -50, minY: -50, maxX: 250, maxY: 50 });
  });

  it('has no bounds for an empty or unknown group', () => {
    const d = doc();
    expect(d.groupBounds(G)).toBeUndefined();
  });
});

describe('snapshots', () => {
  it('replaces content and rebuilds the index', () => {
    const d = doc();
    d.apply(create(A));
    const items: CanvasItem[] = [
      {
        id: B,
        transform: at(400, 400),
        z: 1,
        content: { kind: 'placeholder', intrinsicWidth: 10, intrinsicHeight: 10 },
        appearance: DEFAULT_APPEARANCE,
        crop: FULL_CROP,
      },
    ];
    d.loadSnapshot(items, [], 77);
    expect(d.itemCount).toBe(1);
    expect(d.item(A)).toBeUndefined();
    expect(d.revision).toBe(77);
    expect(d.index.search(transformBounds(at(400, 400)))).toEqual([B]);
  });
});

/**
 * What a round trip must restore. `revision` is left out on purpose: it counts
 * changes, like the server's, so an undo moves it forward rather than back.
 */
function snapshot(d: CanvasDocument) {
  return {
    items: [...d.items()]
      .map(({ revision: _, ...rest }) => rest)
      .sort((a, b) => a.id.localeCompare(b.id)),
    groups: [...d.groups()].sort((a, b) => a.id.localeCompare(b.id)),
    links: [...d.links()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('operation origin', () => {
  it('reports local as the default, so existing callers are unchanged', () => {
    const d = doc();
    const seen: [CanvasOperationBody, string][] = [];
    d.onApplied((body, origin) => seen.push([body, origin]));
    d.apply(create(A));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[1]).toBe('local');
  });

  it('reports remote when told, so persistence can decline to echo it', () => {
    const d = doc();
    const origins: string[] = [];
    d.onApplied((_body, origin) => origins.push(origin));
    d.apply(create(A), 'remote');
    d.apply({ type: 'item.transform', itemId: A, transform: at(500, 500) }, 'remote');
    expect(origins).toEqual(['remote', 'remote']);
  });

  it('applies a remote operation exactly as a local one — index included', () => {
    const local = doc();
    const remote = doc();
    local.apply(create(A, 10, 20));
    remote.apply(create(A, 10, 20), 'remote');

    expect(snapshot(remote)).toEqual(snapshot(local));
    expect(remote.index.search(transformBounds(at(10, 20)))).toEqual([A]);

    remote.apply({ type: 'item.transform', itemId: A, transform: at(600, 600) }, 'remote');
    expect(remote.index.search(transformBounds(at(10, 20)))).toEqual([]);
    expect(remote.index.search(transformBounds(at(600, 600)))).toEqual([A]);
  });

  it('does not report a remote no-op, because nothing changed', () => {
    const d = doc();
    const origins: string[] = [];
    d.onApplied((_body, origin) => origins.push(origin));
    d.apply({ type: 'item.transform', itemId: A, transform: at(1, 1) }, 'remote');
    expect(origins).toEqual([]);
  });
});

/**
 * What framing reads. The claim is not just the answer but the cost: it is the
 * value RBush already holds, so a 100,000-item board does not iterate.
 */
describe('the index knows its own extent', () => {
  it('has no bounds when it holds nothing', () => {
    expect(doc().index.bounds()).toBeUndefined();
  });

  it('is the union of everything in it', () => {
    const d = doc();
    d.apply(create(A, 0, 0));
    d.apply(create(B, 500, 300));

    expect(d.index.bounds()).toEqual({ minX: -50, minY: -50, maxX: 550, maxY: 350 });
  });

  it('shrinks again when items go', () => {
    const d = doc();
    d.apply(create(A, 0, 0));
    d.apply(create(B, 500, 300));
    d.apply({ type: 'item.delete', itemId: B });

    expect(d.index.bounds()).toEqual(transformBounds(at(0, 0)));
  });
});
