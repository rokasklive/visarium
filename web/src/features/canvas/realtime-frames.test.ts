import { MAX_FRAME_ITEMS, PRESENCE_COLOUR_SLOTS } from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { parseServerMessage } from './realtime-frames';

/**
 * Frames arriving from the socket are untrusted input, and this file is where
 * that stops being a slogan.
 *
 * The valid cases matter less than the hostile ones: the guards exist to keep a
 * `NaN` out of the spatial index and an unbounded array out of memory, and a
 * test that only feeds them well-formed frames proves neither.
 */

const uuid = () => crypto.randomUUID();
const frame = (value: unknown) => parseServerMessage(JSON.stringify(value));

describe('parseServerMessage', () => {
  it('rejects anything that is not a frame', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('7')).toBeNull();
    expect(frame({ noType: true })).toBeNull();
    expect(frame({ t: 42 })).toBeNull();
  });

  it('drops a frame type it does not know, because a newer server is not an error', () => {
    expect(frame({ t: 'telepathy', thought: 'hello' })).toBeNull();
  });

  describe('welcome', () => {
    it('accepts a well-formed roster', () => {
      const actorId = uuid();
      const parsed = frame({
        t: 'welcome',
        actorId,
        revision: 12,
        actors: [{ actorId, displayName: 'Ada', colourIndex: 0 }],
      });
      expect(parsed).toMatchObject({ t: 'welcome', revision: 12 });
    });

    it('rejects a colour index outside the token range', () => {
      const bad = (colourIndex: number) =>
        frame({
          t: 'welcome',
          actorId: uuid(),
          revision: 0,
          actors: [{ actorId: uuid(), displayName: 'Ada', colourIndex }],
        });
      expect(bad(-1)).toBeNull();
      expect(bad(PRESENCE_COLOUR_SLOTS)).toBeNull();
      expect(bad(PRESENCE_COLOUR_SLOTS - 1)).not.toBeNull();
    });

    it('rejects a non-integer revision', () => {
      expect(frame({ t: 'welcome', actorId: uuid(), revision: 1.5, actors: [] })).toBeNull();
      expect(frame({ t: 'welcome', actorId: uuid(), revision: 'twelve', actors: [] })).toBeNull();
    });
  });

  describe('cursor', () => {
    it('accepts finite coordinates', () => {
      expect(frame({ t: 'cursor', actorId: uuid(), x: -1.5, y: 0 })).toMatchObject({
        x: -1.5,
        y: 0,
      });
    });

    it('rejects the values that would corrupt a scene', () => {
      const actorId = uuid();
      // JSON cannot carry a literal NaN, so these are the shapes that actually
      // arrive: a string pretending, or a null where a number belongs.
      expect(frame({ t: 'cursor', actorId, x: 'NaN', y: 0 })).toBeNull();
      expect(frame({ t: 'cursor', actorId, x: null, y: 0 })).toBeNull();
      expect(frame({ t: 'cursor', actorId, y: 0 })).toBeNull();
      expect(
        parseServerMessage(`{"t":"cursor","actorId":"${actorId}","x":1e999,"y":0}`),
      ).toBeNull();
    });
  });

  describe('bounded arrays', () => {
    it('accepts an array at the bound and rejects one past it', () => {
      const at = Array.from({ length: MAX_FRAME_ITEMS }, uuid);
      const over = [...at, uuid()];
      expect(frame({ t: 'selection', actorId: uuid(), itemIds: at })).not.toBeNull();
      expect(frame({ t: 'selection', actorId: uuid(), itemIds: over })).toBeNull();
    });

    it('rejects an array holding the wrong type', () => {
      expect(frame({ t: 'selection', actorId: uuid(), itemIds: [7] })).toBeNull();
      expect(frame({ t: 'selection', actorId: uuid(), itemIds: 'all' })).toBeNull();
    });
  });

  describe('transform.preview', () => {
    it('accepts a multi-item preview', () => {
      const parsed = frame({
        t: 'transform.preview',
        actorId: uuid(),
        items: [
          { itemId: uuid(), transform: { x: 1, y: 2, width: 3, height: 4, rotation: 0 } },
          { itemId: uuid(), transform: { x: 5, y: 6, width: 7, height: 8, rotation: 1.5 } },
        ],
      });
      expect(parsed).toMatchObject({ t: 'transform.preview' });
      expect((parsed as unknown as { items: unknown[] }).items).toHaveLength(2);
    });

    it('rejects a preview whose transform is incomplete or non-finite', () => {
      const itemId = uuid();
      expect(frame({ t: 'transform.preview', actorId: uuid(), items: [{ itemId }] })).toBeNull();
      expect(
        frame({
          t: 'transform.preview',
          actorId: uuid(),
          items: [{ itemId, transform: { x: 1, y: 2, width: 3, height: 4 } }],
        }),
      ).toBeNull();
      expect(
        frame({
          t: 'transform.preview',
          actorId: uuid(),
          items: [{ itemId, transform: { x: 'NaN', y: 2, width: 3, height: 4, rotation: 0 } }],
        }),
      ).toBeNull();
    });
  });

  describe('op', () => {
    const transform = { x: 0, y: 0, width: 10, height: 10, rotation: 0 };

    it('accepts every operation variant', () => {
      const id = uuid();
      const operations = [
        {
          type: 'item.create',
          itemId: id,
          transform,
          z: 1,
          content: { kind: 'image', asset: { assetId: id, intrinsicWidth: 1, intrinsicHeight: 1 } },
        },
        { type: 'item.delete', itemId: id },
        { type: 'item.transform', itemId: id, transform },
        { type: 'item.z', itemId: id, z: 3 },
        { type: 'group.create', groupId: id, memberIds: [id], label: 'g' },
        { type: 'group.delete', groupId: id },
        { type: 'group.members', groupId: id, memberIds: [id] },
        {
          type: 'item.appearance',
          itemId: id,
          appearance: { opacity: 0.4, flipX: true, flipY: false },
        },
        { type: 'group.label', groupId: id, label: 'renamed' },
        { type: 'group.frame', groupId: id, frame: true },
      ];
      const parsed = frame({ t: 'op', fromRevision: 0, toRevision: 9, operations });
      expect(parsed).toMatchObject({ t: 'op', fromRevision: 0, toRevision: 9 });
    });

    it('rejects an operation with an unknown discriminator', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [{ type: 'item.teleport', itemId: uuid() }],
        }),
      ).toBeNull();
    });

    it('rejects a transform that would poison the spatial index', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [
            { type: 'item.transform', itemId: uuid(), transform: { ...transform, width: 'NaN' } },
          ],
        }),
      ).toBeNull();
    });

    it('accepts a valid crop or none, and refuses one outside the original', () => {
      const withCrop = (crop: unknown) =>
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [{ type: 'item.transform', itemId: uuid(), transform, crop }],
        });
      expect(withCrop(undefined)).not.toBeNull();
      expect(withCrop({ x: 0.25, y: 0, width: 0.5, height: 1 })).not.toBeNull();
      expect(withCrop({ x: 0.6, y: 0, width: 0.5, height: 1 })).toBeNull();
      expect(withCrop({ x: 0, y: 0, width: 0, height: 1 })).toBeNull();
      expect(withCrop({ x: 'NaN', y: 0, width: 0.5, height: 1 })).toBeNull();
      expect(withCrop(null)).toBeNull();
    });

    it('rejects a range that runs backwards', () => {
      expect(frame({ t: 'op', fromRevision: 5, toRevision: 2, operations: [] })).toBeNull();
    });

    /*
     * Every other numeric field on the wire is only checked for finiteness,
     * because what is downstream is the spatial index. Opacity has a RANGE and
     * the schema has a CHECK for it, so the boundary that exists to keep
     * untrusted input out of domain code enforces the range here rather than
     * leaving the database to be the first thing that notices.
     */
    it('rejects an opacity outside its range or not a number at all', () => {
      const withOpacity = (opacity: unknown) =>
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [
            {
              type: 'item.appearance',
              itemId: uuid(),
              appearance: { opacity, flipX: false, flipY: false },
            },
          ],
        });

      expect(withOpacity(-0.01)).toBeNull();
      expect(withOpacity(1.01)).toBeNull();
      expect(withOpacity('half')).toBeNull();
      expect(withOpacity(null)).toBeNull();
      // JSON has no NaN literal, so a client sending one sends a string.
      expect(withOpacity('NaN')).toBeNull();
      expect(withOpacity(0)).not.toBeNull();
      expect(withOpacity(1)).not.toBeNull();
    });

    it('rejects a flip that is not a boolean', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [
            {
              type: 'item.appearance',
              itemId: uuid(),
              appearance: { opacity: 1, flipX: 'yes', flipY: false },
            },
          ],
        }),
      ).toBeNull();
    });

    it('rejects an appearance on an item.create as strictly as one on its own', () => {
      const create = (appearance: unknown) => {
        const id = uuid();
        return frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [
            {
              type: 'item.create',
              itemId: id,
              transform,
              z: 0,
              content: {
                kind: 'image',
                asset: { assetId: id, intrinsicWidth: 1, intrinsicHeight: 1 },
              },
              ...(appearance === undefined ? {} : { appearance }),
            },
          ],
        });
      };

      expect(create({ opacity: 2, flipX: false, flipY: false })).toBeNull();
      // Absent is valid: an older client's creation is still understood.
      expect(create(undefined)).not.toBeNull();
    });

    it('rejects a group.label with no label', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [{ type: 'group.label', groupId: uuid() }],
        }),
      ).toBeNull();
    });

    it('rejects a group.frame without a boolean flag', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [{ type: 'group.frame', groupId: uuid(), frame: 'yes' }],
        }),
      ).toBeNull();
    });

    it('rejects a group.create whose frame is not a boolean', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [{ type: 'group.create', groupId: uuid(), memberIds: [uuid()], frame: 1 }],
        }),
      ).toBeNull();
    });

    it('rejects an item.create whose content is malformed', () => {
      expect(
        frame({
          t: 'op',
          fromRevision: 0,
          toRevision: 1,
          operations: [
            { type: 'item.create', itemId: uuid(), transform, z: 0, content: { kind: 'image' } },
          ],
        }),
      ).toBeNull();
    });
  });

  describe('lock', () => {
    it('accepts a grant and a release', () => {
      const itemId = uuid();
      const holder = uuid();
      expect(frame({ t: 'lock', itemIds: [itemId], heldBy: holder, expiresAt: 1 })).toMatchObject({
        heldBy: holder,
      });
      expect(frame({ t: 'lock', itemIds: [itemId], heldBy: null, expiresAt: 0 })).toMatchObject({
        heldBy: null,
      });
    });

    it('rejects a holder that is neither a string nor null', () => {
      expect(frame({ t: 'lock', itemIds: [uuid()], heldBy: 7, expiresAt: 1 })).toBeNull();
      expect(frame({ t: 'lock', itemIds: [uuid()], expiresAt: 1 })).toBeNull();
    });
  });

  it('accepts presence with either half absent', () => {
    expect(frame({ t: 'presence', joined: [] })).toMatchObject({ t: 'presence' });
    expect(frame({ t: 'presence', left: [uuid()] })).toMatchObject({ t: 'presence' });
    expect(frame({ t: 'presence' })).toMatchObject({ t: 'presence' });
    expect(frame({ t: 'presence', left: 'everyone' })).toBeNull();
  });
});

describe('board objects and links arrive from other people', () => {
  const op = (operations: unknown[]) =>
    parseServerMessage(
      JSON.stringify({ t: 'op', fromRevision: 1, toRevision: 1 + operations.length, operations }),
    );
  const create = (content: unknown) => ({
    type: 'item.create',
    itemId: 'i',
    z: 1,
    transform: { x: 0, y: 0, width: 320, height: 80, rotation: 0 },
    content,
  });

  it('accepts every new operation and content kind, stamps and all', () => {
    const frame = op([
      create({ kind: 'note', source: '### Hi' }),
      create({ kind: 'diagram', lang: 'plantuml', source: '@startuml' }),
      create({
        kind: 'checklist',
        title: 'T',
        tasks: [{ id: 't1', text: 'x', state: 'done', by: 'u', at: '2026-11-19T00:00:00Z' }],
      }),
      { type: 'item.source', itemId: 'i', source: 'x', baseRevision: 3 },
      { type: 'checklist.title', itemId: 'i', title: 'T2' },
      {
        type: 'task.add',
        itemId: 'i',
        task: { id: 't2', text: 'y', state: 'todo', by: null },
        index: 0,
      },
      { type: 'task.set', itemId: 'i', taskId: 't1', state: 'blocked', by: 'u', at: 'now' },
      { type: 'task.remove', itemId: 'i', taskId: 't2' },
      {
        type: 'link.add',
        linkId: 'l',
        from: { itemId: 'i' },
        to: { itemId: 'j', element: 'Pay' },
        linkType: 'implements',
        by: 'u',
      },
      { type: 'link.set', linkId: 'l', linkType: 'comments' },
      { type: 'link.delete', linkId: 'l' },
    ]);
    expect(frame?.t).toBe('op');
  });

  it.each([
    [
      'a diagram in an unknown language',
      create({ kind: 'diagram', lang: 'graphviz', source: 'x' }),
    ],
    ['a task in an unknown state', { type: 'task.set', itemId: 'i', taskId: 't', state: 'maybe' }],
    [
      'a link of an unknown type',
      {
        type: 'link.add',
        linkId: 'l',
        from: { itemId: 'i' },
        to: { itemId: 'j' },
        linkType: 'likes',
      },
    ],
    [
      'a link end that is not an anchor',
      { type: 'link.add', linkId: 'l', from: 'i', to: { itemId: 'j' }, linkType: 'describes' },
    ],
    ['source that is not text', { type: 'item.source', itemId: 'i', source: 3 }],
  ])('drops a frame carrying %s', (_, body) => {
    expect(op([body])).toBeNull();
  });
});

describe('agents on the board (ADR-0031)', () => {
  it('reads an agent participant and ignores presence fields it does not know', () => {
    const actorId = uuid();
    const parsed = frame({
      t: 'presence',
      joined: [
        {
          actorId,
          displayName: 'Claude Code',
          colourIndex: 1,
          kind: 'agent',
          person: 'Ada',
          mood: 'keen',
        },
      ],
    });
    expect(parsed).toEqual({
      t: 'presence',
      joined: [
        { actorId, displayName: 'Claude Code', colourIndex: 1, kind: 'agent', person: 'Ada' },
      ],
    });
    const person = frame({
      t: 'presence',
      joined: [{ actorId, displayName: 'Ada', colourIndex: 0, kind: 'robot' }],
    });
    expect(person).toEqual({
      t: 'presence',
      joined: [{ actorId, displayName: 'Ada', colourIndex: 0 }],
    });
  });

  it('reads a focus frame and refuses one it cannot trust', () => {
    const actorId = uuid();
    const itemId = uuid();
    expect(frame({ t: 'focus', actorId, itemId, verb: 'reading' })).toEqual({
      t: 'focus',
      actorId,
      itemId,
      verb: 'reading',
    });
    expect(frame({ t: 'focus', actorId, itemId, verb: 'deleting' })).toBeNull();
    expect(frame({ t: 'focus', actorId, verb: 'reading' })).toBeNull();
  });

  it('keeps byAgent on stamped operations', () => {
    const parsed = frame({
      t: 'op',
      fromRevision: 1,
      toRevision: 2,
      operations: [
        {
          type: 'task.set',
          itemId: uuid(),
          taskId: 't1',
          state: 'done',
          by: uuid(),
          byAgent: 'Claude Code',
          at: '2026-11-19T10:00:00Z',
        },
      ],
    });
    expect(parsed).toMatchObject({ operations: [{ byAgent: 'Claude Code' }] });
  });
});

describe('the board itself changes (agents/board-management)', () => {
  it('reads a rename and a deletion, with who did it', () => {
    expect(frame({ t: 'board', title: 'Feature tour', by: 'Claude for Ada' })).toEqual({
      t: 'board',
      title: 'Feature tour',
      by: 'Claude for Ada',
    });
    expect(frame({ t: 'board-deleted', by: 'Claude for Ada' })).toEqual({
      t: 'board-deleted',
      by: 'Claude for Ada',
    });
    expect(frame({ t: 'board', title: 3, by: 'x' })).toBeNull();
    expect(frame({ t: 'board-deleted' })).toBeNull();
  });
});
