import { describe, expect, it } from 'vitest';
import { CanvasDocument } from './document';
import { frameAt, membershipBodies } from './frames';
import type { Transform } from './geometry';
import { CanvasHistory } from './history';
import { asCanvasId, asGroupId, asItemId, type GroupId, type ItemId } from './ids';
import type { CanvasOperationBody } from './operations';

/** A 100×100 item centred at (x, y). */
const at = (x: number, y: number): Transform => ({ x, y, width: 100, height: 100, rotation: 0 });

function board() {
  const doc = new CanvasDocument(asCanvasId('frames'));
  let z = 0;
  const item = (name: string, x: number, y: number): ItemId => {
    const itemId = asItemId(name);
    doc.apply({
      type: 'item.create',
      itemId,
      transform: at(x, y),
      z: z++,
      content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
    });
    return itemId;
  };
  const group = (name: string, members: ItemId[], frame = true): GroupId => {
    const groupId = asGroupId(name);
    doc.apply({ type: 'group.create', groupId, memberIds: members, frame });
    return groupId;
  };
  const members = (g: GroupId) => [...(doc.group(g)?.memberIds ?? [])].sort();
  return { doc, item, group, members };
}

const none = new Set<ItemId>();

function applyAll(doc: CanvasDocument, bodies: CanvasOperationBody[]) {
  for (const body of bodies) doc.apply(body);
}

describe('frameAt', () => {
  it('finds the frame around a point and nothing outside it', () => {
    const { doc, item, group } = board();
    const g = group('g', [item('a', 0, 0), item('b', 150, 0)]);
    expect(frameAt(doc, { x: 75, y: 0 }, none)).toBe(g);
    expect(frameAt(doc, { x: 1000, y: 0 }, none)).toBeUndefined();
  });

  it('picks the smaller of two overlapping frames', () => {
    const { doc, item, group } = board();
    group('big', [item('a', 0, 0), item('b', 600, 600)]); // bounding box covers (300, 300)
    const small = group('small', [item('c', 300, 300)]);
    expect(frameAt(doc, { x: 300, y: 300 }, none)).toBe(small);
  });

  it('ignores a frame whose only member is excluded', () => {
    const { doc, item, group } = board();
    const a = item('a', 0, 0);
    group('g', [a]);
    expect(frameAt(doc, { x: 0, y: 0 }, new Set([a]))).toBeUndefined();
  });

  it('never hits an unframed group', () => {
    const { doc, item, group } = board();
    group('g', [item('a', 0, 0), item('b', 150, 0)], false);
    expect(frameAt(doc, { x: 75, y: 0 }, none)).toBeUndefined();
  });
});

describe('membershipBodies', () => {
  it('adds a loose item dropped inside a frame', () => {
    const { doc, item, group, members } = board();
    const g = group('g', [item('a', 0, 0), item('b', 150, 0)]);
    const loose = item('loose', 2000, 0);
    applyAll(doc, membershipBodies(doc, new Map([[loose, at(75, 0)]])));
    expect(members(g)).toEqual(['a', 'b', 'loose']);
    expect(doc.item(loose)?.groupId).toBe(g);
  });

  it('adds several loose items dropped together', () => {
    const { doc, item, group, members } = board();
    const g = group('g', [
      item('a', 0, 0),
      item('b', 300, 0),
      item('c', 0, 300),
      item('d', 300, 300),
    ]);
    const x = item('x', 2000, 0);
    const y = item('y', 2200, 0);
    applyAll(
      doc,
      membershipBodies(
        doc,
        new Map([
          [x, at(150, 0)],
          [y, at(150, 300)],
        ]),
      ),
    );
    expect(members(g)).toEqual(['a', 'b', 'c', 'd', 'x', 'y']);
  });

  it('moves a member from one frame to another', () => {
    const { doc, item, group, members } = board();
    const m = item('m', 0, 0);
    const ga = group('A', [m, item('a', 150, 0)]);
    const gb = group('B', [item('b', 1000, 0), item('c', 1150, 0)]);
    applyAll(doc, membershipBodies(doc, new Map([[m, at(1075, 0)]])));
    expect(members(ga)).toEqual(['a']);
    expect(members(gb)).toEqual(['b', 'c', 'm']);
    expect(doc.item(m)?.groupId).toBe(gb);
  });

  it('takes a member dropped outside its frame out of the group', () => {
    const { doc, item, group, members } = board();
    const m = item('m', 0, 0);
    const g = group('g', [m, item('a', 150, 0), item('b', 0, 150)]);
    applyAll(doc, membershipBodies(doc, new Map([[m, at(-1000, 0)]])));
    expect(members(g)).toEqual(['a', 'b']);
    expect(doc.item(m)?.groupId).toBeUndefined();
  });

  it('keeps a corner member nudged within its frame', () => {
    const { doc, item, group } = board();
    const m = item('m', 0, 0);
    group('g', [m, item('a', 150, 0), item('b', 0, 150), item('c', 150, 150)]);
    // Without m the top-left corner is empty, but the frame as drawn holds it.
    expect(membershipBodies(doc, new Map([[m, at(-20, -20)]]))).toEqual([]);
  });

  it('keeps a member released back inside its frame, whatever path it took', () => {
    const { doc, item, group } = board();
    const m = item('m', 0, 0);
    group('g', [m, item('a', 150, 0), item('b', 0, 150), item('c', 150, 150)]);
    // Only the release position counts: it ends where it began.
    expect(membershipBodies(doc, new Map([[m, at(10, 10)]]))).toEqual([]);
  });

  it('never moves a group carried whole into another frame', () => {
    const { doc, item, group } = board();
    const a = item('a', 0, 0);
    const b = item('b', 150, 0);
    group('A', [a, b]);
    group('B', [item('c', 1000, 0), item('d', 1150, 0)]);
    const drop = new Map([
      [a, at(1000, 0)],
      [b, at(1150, 0)],
    ]);
    expect(membershipBodies(doc, drop)).toEqual([]);
  });

  it('leaves members of unframed groups alone', () => {
    const { doc, item, group } = board();
    const m = item('m', 0, 0);
    group('g', [m, item('a', 150, 0)], false);
    expect(membershipBodies(doc, new Map([[m, at(5000, 0)]]))).toEqual([]);
  });

  it('is one undo step together with the move', () => {
    const { doc, item, group, members } = board();
    const history = new CanvasHistory(doc);
    const g = group('g', [item('a', 0, 0), item('b', 150, 0)]);
    const loose = item('loose', 2000, 0);
    const to = at(75, 0);
    history.apply(
      { type: 'item.transform', itemId: loose, transform: to },
      ...membershipBodies(doc, new Map([[loose, to]])),
    );
    expect(members(g)).toEqual(['a', 'b', 'loose']);
    history.undo();
    expect(members(g)).toEqual(['a', 'b']);
    expect(doc.item(loose)?.groupId).toBeUndefined();
    expect(doc.item(loose)?.transform.x).toBe(2000);
  });
});
