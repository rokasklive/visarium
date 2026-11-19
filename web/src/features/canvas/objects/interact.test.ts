import { asItemId } from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import {
  createObject,
  hitAt,
  localToWorld,
  newTaskId,
  nextState,
  setTaskBox,
  taskBoxChecked,
  worldToLocal,
} from './interact';
import type { Layout } from './layout';

describe('a checkbox in a note', () => {
  const source =
    '### Shot list\n\n- [ ] one\n- [x] two\n  * [ ] nested three\n\n1. [ ] numbered four';

  it('changes exactly its own marker', () => {
    expect(setTaskBox(source, 0, true)).toBe(source.replace('- [ ] one', '- [x] one'));
    expect(setTaskBox(source, 1, false)).toBe(source.replace('- [x] two', '- [ ] two'));
    expect(setTaskBox(source, 2, true)).toBe(source.replace('* [ ] nested', '* [x] nested'));
    expect(setTaskBox(source, 3, true)).toBe(source.replace('1. [ ] numbered', '1. [x] numbered'));
  });

  it('reads a box back', () => {
    expect([0, 1, 2, 3].map((i) => taskBoxChecked(source, i))).toEqual([false, true, false, false]);
  });

  it('leaves the source alone when there is no such box', () => {
    expect(setTaskBox(source, 9, true)).toBe(source);
  });
});

describe('task state', () => {
  it('moves on with a click and blocks with Shift', () => {
    expect(['todo', 'doing', 'done'].map((s) => nextState(s as never, false))).toEqual([
      'doing',
      'done',
      'todo',
    ]);
    expect(nextState('doing', true)).toBe('blocked');
    expect(nextState('blocked', true)).toBe('todo');
    expect(nextState('blocked', false)).toBe('todo');
  });

  it('mints ids past the highest in use', () => {
    expect(newTaskId([])).toBe('t1');
    expect(
      newTaskId([
        { id: 't1', text: 'a', state: 'todo' },
        { id: 't7', text: 'b', state: 'todo' },
      ]),
    ).toBe('t8');
    expect(newTaskId([{ id: 'custom', text: 'a', state: 'todo' }])).toBe('t1');
  });
});

describe('hit testing', () => {
  const layout = {
    width: 320,
    height: 100,
    hits: [{ kind: 'checkbox', index: 0, rect: { x: 0, y: 40, width: 14, height: 14 } }],
    elements: new Map(),
    svg: () => '',
  } as unknown as Layout;

  it('finds a control under the point, with a little slack', () => {
    expect(hitAt(layout, { x: 7, y: 47 })?.kind).toBe('checkbox');
    expect(hitAt(layout, { x: 16, y: 47 })?.kind).toBe('checkbox');
    expect(hitAt(layout, { x: 60, y: 47 })).toBeUndefined();
  });
});

describe('item-local coordinates', () => {
  const t = { x: 100, y: 50, width: 200, height: 100, rotation: Math.PI / 2 };

  it('round-trip through a rotated item', () => {
    const local = { x: 30, y: 20 };
    const back = worldToLocal(t, localToWorld(t, local));
    expect(back.x).toBeCloseTo(30, 9);
    expect(back.y).toBeCloseTo(20, 9);
  });

  it('put the local origin on the item’s stored top-left corner', () => {
    const p = localToWorld({ ...t, rotation: 0 }, { x: 0, y: 0 });
    expect(p).toEqual({ x: 0, y: 0 });
  });
});

describe('creating an object', () => {
  it('centres it horizontally on the point and hangs it from there', () => {
    const body = createObject(asItemId('n'), { kind: 'note', source: 'x' }, { x: 10, y: 20 }, 5);
    expect(body).toMatchObject({ type: 'item.create', z: 5, transform: { x: 10, width: 320 } });
    if (body.type !== 'item.create') throw new Error('not a create');
    expect(body.transform.y - body.transform.height / 2).toBe(20);
  });
});
