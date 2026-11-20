import { describe, expect, it } from 'vitest';
import { CanvasDocument, deleteItemsBodies } from './document';
import { CanvasHistory } from './history';
import { asCanvasId, asItemId, asLinkId } from './ids';
import {
  type CanvasItem,
  type CanvasItemContent,
  contentFrom,
  DEFAULT_APPEARANCE,
  FULL_CROP,
  itemIntrinsicSize,
  type Link,
} from './model';
import type { CanvasOperationBody } from './operations';

const NOTE = asItemId('note');
const FLOW = asItemId('flow');
const LIST = asItemId('list');
const L1 = asLinkId('l1');
const L2 = asLinkId('l2');
const box = { x: 0, y: 0, width: 320, height: 120, rotation: 0 };

const create = (itemId: typeof NOTE, content: CanvasItemContent): CanvasOperationBody => ({
  type: 'item.create',
  itemId,
  transform: box,
  z: 0,
  content,
});

/** A board like the Objects Lab's: a note, a flowchart and a checklist. */
function board() {
  const d = new CanvasDocument(asCanvasId('b'));
  d.apply(create(NOTE, { kind: 'note', source: '### Overview' }));
  d.apply(
    create(FLOW, { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  API --> Pay' }),
  );
  d.apply(
    create(LIST, {
      kind: 'checklist',
      title: 'Build',
      tasks: [
        { id: 't1', text: 'Interface', state: 'done' },
        { id: 't2', text: 'Keys', state: 'todo' },
      ],
    }),
  );
  return d;
}

const tasks = (d: CanvasDocument) => {
  const c = d.item(LIST)?.content;
  return c?.kind === 'checklist' ? c.tasks : [];
};

/** Everything an undo must restore, without the revision counter (it only counts up). */
const state = (d: CanvasDocument) => ({
  items: [...d.items()].map(({ revision: _, ...rest }) => rest),
  links: [...d.links()],
});

const roundTrip = (d: CanvasDocument, op: CanvasOperationBody) => {
  const before = state(d);
  const inverse = d.apply(op);
  expect(inverse, `${op.type} produced no inverse`).toBeDefined();
  expect(state(d)).not.toEqual(before);
  d.apply(inverse as CanvasOperationBody);
  expect(state(d)).toEqual(before);
};

describe('note, diagram and checklist items', () => {
  it('are created with their source, and loaded back from a snapshot with their links', () => {
    const d = board();
    d.apply({
      type: 'link.add',
      linkId: L1,
      from: { itemId: NOTE },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    });
    const again = new CanvasDocument(asCanvasId('b'));
    again.loadSnapshot([...d.items()], [], 9, [...d.links()]);
    expect(again.item(FLOW)?.content).toEqual({
      kind: 'diagram',
      lang: 'mermaid',
      source: 'flowchart LR\n  API --> Pay',
    });
    expect(again.linksOf(FLOW).map((l) => l.to.element)).toEqual(['Pay']);
    expect(again.revision).toBe(9);
  });

  it('is laid out at its box, which is its intrinsic size', () => {
    const d = board();
    expect(itemIntrinsicSize(d.item(NOTE) as CanvasItem)).toEqual({ width: 320, height: 120 });
  });
});

describe('content from the wire', () => {
  it('models every kind it knows', () => {
    expect(contentFrom({ kind: 'note', source: 'x' })).toEqual({ kind: 'note', source: 'x' });
    expect(contentFrom({ kind: 'diagram', lang: 'plantuml', source: '@startuml' })).toEqual({
      kind: 'diagram',
      lang: 'plantuml',
      source: '@startuml',
    });
    expect(
      contentFrom({
        kind: 'image',
        asset: { assetId: 'a', intrinsicWidth: 6, intrinsicHeight: 4 },
      }),
    ).toEqual({
      kind: 'image',
      asset: { assetId: 'a', intrinsicWidth: 6, intrinsicHeight: 4 },
    });
  });

  it('cleans a checklist: unknown states become todo, tasks without ids are dropped', () => {
    expect(
      contentFrom({
        kind: 'checklist',
        title: 'T',
        tasks: [{ id: 'a', text: 'x', state: 'maybe' }, { text: 'no id' }],
      }),
    ).toEqual({
      kind: 'checklist',
      title: 'T',
      tasks: [{ id: 'a', text: 'x', state: 'todo', by: null, at: null }],
    });
  });

  it('keeps what it cannot model as inert unknown content, not a guess', () => {
    expect(contentFrom({ kind: 'sticker' })).toEqual({ kind: 'unknown', original: 'sticker' });
    expect(contentFrom({ kind: 'diagram', lang: 'graphviz', source: 'x' })).toEqual({
      kind: 'unknown',
      original: 'diagram:graphviz',
    });
  });

  it('refuses an image with no asset: that is a broken contract, not an item', () => {
    expect(contentFrom({ kind: 'image', asset: {} })).toBeUndefined();
  });
});

describe('operations on objects, and their inverses', () => {
  it('replaces source', () =>
    roundTrip(board(), {
      type: 'item.source',
      itemId: FLOW,
      source: 'flowchart LR\n  API --> Payments',
    }));
  it('renames a checklist', () =>
    roundTrip(board(), { type: 'checklist.title', itemId: LIST, title: 'Build it' }));
  it('adds a task at a position', () => {
    const d = board();
    d.apply({
      type: 'task.add',
      itemId: LIST,
      task: { id: 't3', text: 'Between', state: 'todo' },
      index: 1,
    });
    expect(tasks(d).map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    roundTrip(board(), {
      type: 'task.add',
      itemId: LIST,
      task: { id: 't3', text: 'Between', state: 'todo' },
      index: 1,
    });
  });
  it('changes a task', () =>
    roundTrip(board(), { type: 'task.set', itemId: LIST, taskId: 't2', state: 'doing' }));
  it('removes a task, and undo puts it back where it was', () =>
    roundTrip(board(), { type: 'task.remove', itemId: LIST, taskId: 't1' }));
  it('adds, retypes and deletes links', () => {
    const d = board();
    roundTrip(d, {
      type: 'link.add',
      linkId: L1,
      from: { itemId: LIST },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'implements',
    });
    d.apply({
      type: 'link.add',
      linkId: L1,
      from: { itemId: LIST },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'implements',
    });
    roundTrip(d, { type: 'link.set', linkId: L1, linkType: 'depends-on' });
    roundTrip(d, { type: 'link.delete', linkId: L1 });
  });

  it('names only the fields a task change touched, so undo leaves the rest alone', () => {
    const d = board();
    expect(d.apply({ type: 'task.set', itemId: LIST, taskId: 't2', state: 'done' })).toEqual({
      type: 'task.set',
      itemId: LIST,
      taskId: 't2',
      state: 'todo',
    });
  });

  it('ignores what does not fit, the way every operation ignores an unknown target', () => {
    const d = board();
    expect(d.apply({ type: 'item.source', itemId: LIST, source: 'x' })).toBeUndefined();
    expect(
      d.apply({ type: 'task.add', itemId: NOTE, task: { id: 'x', text: 'x', state: 'todo' } }),
    ).toBeUndefined();
    expect(
      d.apply({ type: 'task.add', itemId: LIST, task: { id: 't1', text: 'dup', state: 'todo' } }),
    ).toBeUndefined();
    expect(
      d.apply({ type: 'task.set', itemId: LIST, taskId: 'gone', state: 'done' }),
    ).toBeUndefined();
    expect(
      d.apply({
        type: 'link.add',
        linkId: L1,
        from: { itemId: NOTE },
        to: { itemId: NOTE },
        linkType: 'describes',
      }),
    ).toBeUndefined();
    expect(
      d.apply({
        type: 'link.add',
        linkId: L1,
        from: { itemId: NOTE },
        to: { itemId: asItemId('nowhere') },
        linkType: 'describes',
      }),
    ).toBeUndefined();
  });
});

describe('the per-item revision', () => {
  it('starts at 0 and counts every change the server counts', () => {
    const d = board();
    expect(d.item(LIST)?.revision).toBe(0);
    d.apply({ type: 'task.set', itemId: LIST, taskId: 't2', state: 'doing' });
    d.apply({ type: 'item.z', itemId: LIST, z: 3 });
    expect(d.item(LIST)?.revision).toBe(2);
    d.apply({ type: 'task.set', itemId: LIST, taskId: 'gone', state: 'done' });
    expect(d.item(LIST)?.revision, 'a no-op counts nothing, as on the server').toBe(2);
  });

  it('stays unknown for an item loaded without one', () => {
    const d = new CanvasDocument(asCanvasId('b'));
    const item: CanvasItem = {
      id: NOTE,
      transform: box,
      z: 0,
      content: { kind: 'note', source: 'x' },
      appearance: DEFAULT_APPEARANCE,
      crop: FULL_CROP,
    };
    d.loadSnapshot([item], [], 1);
    d.apply({ type: 'item.source', itemId: NOTE, source: 'y' });
    expect(d.item(NOTE)?.revision).toBeUndefined();
  });
});

describe('undo is yours, task by task', () => {
  it("reverts my task change without reverting someone else's change to another task", () => {
    const d = board();
    const history = new CanvasHistory(d);
    history.apply({ type: 'task.set', itemId: LIST, taskId: 't2', state: 'done' });
    d.apply(
      { type: 'task.set', itemId: LIST, taskId: 't1', text: 'Interface, agreed', by: 'u2' },
      'remote',
    );
    history.undo();
    expect(tasks(d).map((t) => [t.id, t.state, t.text])).toEqual([
      ['t1', 'done', 'Interface, agreed'],
      ['t2', 'todo', 'Keys'],
    ]);
  });
});

describe('an editing session is one undo step', () => {
  it('records the whole session from its first text, however many saves it made', () => {
    const d = board();
    const history = new CanvasHistory(d);
    for (const source of ['### O', '### Ov', '### Overview v2'])
      d.apply({ type: 'item.source', itemId: NOTE, source });
    history.record({ type: 'item.source', itemId: NOTE, source: '### Overview' });
    expect(history.depth).toBe(1);
    history.undo();
    expect(d.item(NOTE)?.content).toEqual({ kind: 'note', source: '### Overview' });
    history.redo();
    expect(d.item(NOTE)?.content).toEqual({ kind: 'note', source: '### Overview v2' });
  });
});

describe('deleting items with their links', () => {
  it('cascades links when an item goes, as the server does', () => {
    const d = board();
    d.apply({
      type: 'link.add',
      linkId: L1,
      from: { itemId: NOTE },
      to: { itemId: FLOW },
      linkType: 'describes',
    });
    d.apply({ type: 'item.delete', itemId: FLOW });
    expect([...d.links()]).toEqual([]);
  });

  it('brings an item and every link it had back in one undo', () => {
    const d = board();
    d.apply({
      type: 'link.add',
      linkId: L1,
      from: { itemId: NOTE },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    });
    d.apply({
      type: 'link.add',
      linkId: L2,
      from: { itemId: LIST },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'implements',
    });
    const before: Link[] = [...d.links()];
    const history = new CanvasHistory(d);
    const bodies = deleteItemsBodies(d, [FLOW, LIST]);
    expect(
      bodies.filter((b) => b.type === 'link.delete'),
      'each link deleted once',
    ).toHaveLength(2);
    history.apply(...bodies);
    expect(d.item(FLOW)).toBeUndefined();
    expect([...d.links()]).toEqual([]);
    history.undo();
    expect(d.item(FLOW)?.content.kind).toBe('diagram');
    expect(d.item(LIST)?.content.kind).toBe('checklist');
    expect([...d.links()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(before);
  });
});
