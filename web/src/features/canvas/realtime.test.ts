import {
  asCanvasId,
  asItemId,
  CanvasDocument,
  CanvasHistory,
  type CanvasOperationBody,
  PROTOCOL_VERSION,
} from '@visarium/canvas-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardRealtime, FOCUS_MS } from './realtime';

/**
 * The reconciliation rules, without a server.
 *
 * Everything interesting about receiving a commit is arithmetic on two numbers —
 * duplicate, gap, or the one that fits — so it is testable against a fake socket
 * and deserves to be, because the alternative is discovering a gap rule in a
 * browser with three tabs open.
 */

const BOARD = '11111111-1111-1111-1111-111111111111';

/** A WebSocket as far as the client is concerned: it records sends and can be fed frames. */
class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver a frame as the server would. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  deliverRaw(data: string) {
    this.onmessage?.({ data });
  }

  framesOfType(t: string) {
    return this.sent.filter((frame) => (frame as { t: string }).t === t);
  }
}

const transform = (x: number) => ({ x, y: 0, width: 10, height: 10, rotation: 0 });

const create = (itemId: string, x = 0): CanvasOperationBody => ({
  type: 'item.create',
  itemId: asItemId(itemId),
  transform: transform(x),
  z: 0,
  content: { kind: 'placeholder', intrinsicWidth: 10, intrinsicHeight: 10 },
});

function setup(options: { revision?: number } = {}) {
  const doc = new CanvasDocument(asCanvasId(BOARD));
  if (options.revision) doc.setRevision(options.revision);
  const socket = new FakeSocket();
  const resync = vi.fn().mockResolvedValue(undefined);
  const onRemoteChange = vi.fn();
  const onState = vi.fn();
  const onPresence = vi.fn();

  const realtime = new BoardRealtime({
    boardId: BOARD,
    doc,
    resync,
    onPresence,
    onState,
    onRemoteChange,
    socketFactory: () => socket as unknown as WebSocket,
  });
  realtime.connect();
  socket.onopen?.();
  return { doc, socket, realtime, resync, onRemoteChange, onState, onPresence };
}

/** Complete the handshake so the client has an actor id. */
function welcome(socket: FakeSocket, revision = 0, actorId = crypto.randomUUID()) {
  socket.deliver({ t: 'welcome', actorId, revision, actors: [] });
  return actorId;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the handshake', () => {
  it('introduces itself before anything else', () => {
    const { socket } = setup();
    // The constant, not a literal: a version bump is a deliberate act, and this
    // test asserting the handshake's shape is not the place to re-decide it.
    expect(socket.sent[0]).toMatchObject({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      canvasId: BOARD,
    });
  });

  it('reports itself live once welcomed', () => {
    const { socket, onState, realtime } = setup();
    const actorId = welcome(socket);
    expect(onState).toHaveBeenLastCalledWith('live');
    expect(realtime.actorId).toBe(actorId);
  });

  it('resyncs when the board moved on while we were away', () => {
    const { socket, resync } = setup({ revision: 3 });
    welcome(socket, 9);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('does not resync when the board is where we left it', () => {
    const { socket, resync } = setup({ revision: 9 });
    welcome(socket, 9);
    expect(resync).not.toHaveBeenCalled();
  });
});

describe('a malformed frame', () => {
  it('is dropped and counted, and the session carries on', () => {
    const { socket, realtime, onRemoteChange } = setup();
    welcome(socket);

    socket.deliverRaw('not json at all');
    socket.deliverRaw('{"t":"cursor","x":"NaN","y":0}');

    expect(realtime.droppedFrames).toBe(2);
    expect(onRemoteChange).not.toHaveBeenCalled();

    // Still alive: a real frame after two bad ones still lands.
    socket.deliver({
      t: 'presence',
      joined: [{ actorId: crypto.randomUUID(), displayName: 'Ada', colourIndex: 1 }],
    });
    expect(realtime.presence.actors.size).toBe(1);
  });
});

describe('receiving a commit', () => {
  it('applies operations that continue from the revision we hold', () => {
    const { socket, doc, onRemoteChange } = setup();
    welcome(socket);
    const itemId = crypto.randomUUID();

    socket.deliver({ t: 'op', fromRevision: 0, toRevision: 1, operations: [create(itemId)] });

    expect(doc.itemCount).toBe(1);
    expect(doc.revision).toBe(1);
    expect(onRemoteChange).toHaveBeenCalled();
  });

  it('ignores a duplicate rather than applying it twice', () => {
    const { socket, doc } = setup();
    welcome(socket);
    const itemId = crypto.randomUUID();
    const commit = { t: 'op', fromRevision: 0, toRevision: 1, operations: [create(itemId, 5)] };

    socket.deliver(commit);
    socket.deliver(commit);

    expect(doc.itemCount).toBe(1);
    expect(doc.revision).toBe(1);
  });

  it('refetches the snapshot on a gap instead of applying it', () => {
    const { socket, doc, resync } = setup();
    welcome(socket);

    socket.deliver({
      t: 'op',
      fromRevision: 4,
      toRevision: 6,
      operations: [create(crypto.randomUUID())],
    });

    expect(resync).toHaveBeenCalledTimes(1);
    expect(doc.itemCount).toBe(0);
    expect(doc.revision).toBe(0);
  });

  it('never replays: one gap is one snapshot request', () => {
    const { socket, resync } = setup();
    welcome(socket);

    socket.deliver({ t: 'op', fromRevision: 4, toRevision: 6, operations: [] });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('applies remote operations without entering the undo history', () => {
    const { socket, doc } = setup();
    welcome(socket);
    const history = new CanvasHistory(doc);
    const itemId = crypto.randomUUID();

    socket.deliver({ t: 'op', fromRevision: 0, toRevision: 1, operations: [create(itemId)] });

    expect(doc.itemCount).toBe(1);
    expect(history.undo()).toBe(false);
  });

  it('lets a committed transform supersede its preview', () => {
    const { socket, realtime, doc } = setup();
    welcome(socket);
    const itemId = crypto.randomUUID();
    socket.deliver({ t: 'op', fromRevision: 0, toRevision: 1, operations: [create(itemId)] });

    socket.deliver({
      t: 'transform.preview',
      actorId: crypto.randomUUID(),
      items: [{ itemId, transform: transform(99) }],
    });
    expect(realtime.presence.previews.has(asItemId(itemId))).toBe(true);

    socket.deliver({
      t: 'op',
      fromRevision: 1,
      toRevision: 2,
      operations: [{ type: 'item.transform', itemId, transform: transform(50) }],
    });

    expect(realtime.presence.previews.has(asItemId(itemId))).toBe(false);
    expect(doc.item(asItemId(itemId))?.transform.x).toBe(50);
  });

  it('never lets a preview reach the document', () => {
    const { socket, doc, realtime } = setup();
    welcome(socket);
    const itemId = crypto.randomUUID();
    socket.deliver({ t: 'op', fromRevision: 0, toRevision: 1, operations: [create(itemId, 0)] });

    for (let i = 0; i < 50; i++) {
      socket.deliver({
        t: 'transform.preview',
        actorId: crypto.randomUUID(),
        items: [{ itemId, transform: transform(i) }],
      });
    }

    expect(doc.item(asItemId(itemId))?.transform.x).toBe(0);
    expect(doc.revision).toBe(1);
    expect(realtime.presence.previews.get(asItemId(itemId))?.transform.x).toBe(49);
  });
});

describe('presence', () => {
  it('forgets everything about an actor that leaves', () => {
    const { socket, realtime } = setup();
    welcome(socket);
    const other = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    socket.deliver({
      t: 'presence',
      joined: [{ actorId: other, displayName: 'Ada', colourIndex: 2 }],
    });
    socket.deliver({ t: 'cursor', actorId: other, x: 1, y: 2 });
    socket.deliver({ t: 'selection', actorId: other, itemIds: [itemId] });
    socket.deliver({ t: 'lock', itemIds: [itemId], heldBy: other, expiresAt: Date.now() + 10_000 });
    expect(realtime.presence.cursors.size).toBe(1);

    socket.deliver({ t: 'presence', left: [other] });

    expect(realtime.presence.actors.size).toBe(0);
    expect(realtime.presence.cursors.size).toBe(0);
    expect(realtime.presence.selections.size).toBe(0);
    expect(realtime.presence.locks.size).toBe(0);
  });

  it('forgets everyone when the socket drops', () => {
    const { socket, realtime } = setup();
    welcome(socket);
    socket.deliver({
      t: 'presence',
      joined: [{ actorId: crypto.randomUUID(), displayName: 'Ada', colourIndex: 0 }],
    });

    socket.close();

    expect(realtime.presence.actors.size).toBe(0);
  });
});

describe('locks', () => {
  it('reports an item held by someone else, and not one held by us', () => {
    const { socket, realtime } = setup();
    const me = welcome(socket);
    const them = crypto.randomUUID();
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();

    socket.deliver({ t: 'lock', itemIds: [mine], heldBy: me, expiresAt: 0 });
    socket.deliver({ t: 'lock', itemIds: [theirs], heldBy: them, expiresAt: 0 });

    expect(realtime.heldByOther(asItemId(mine))).toBeUndefined();
    expect(realtime.heldByOther(asItemId(theirs))).toBe(them);
  });

  it('stops claiming an item once it has been refused', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    welcome(socket);
    const itemId = asItemId(crypto.randomUUID());

    realtime.acquire([itemId]);
    socket.deliver({ t: 'lock', itemIds: [itemId], heldBy: crypto.randomUUID(), expiresAt: 0 });

    const before = socket.framesOfType('lock.acquire').length;
    vi.advanceTimersByTime(20_000);

    // Without dropping the claim, the heartbeat would ask for it forever.
    expect(socket.framesOfType('lock.acquire').length).toBe(before);
  });

  it('keeps restating a claim it still holds, so a paused gesture does not lose it', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    const me = welcome(socket);
    const itemId = asItemId(crypto.randomUUID());

    realtime.acquire([itemId]);
    socket.deliver({ t: 'lock', itemIds: [itemId], heldBy: me, expiresAt: 0 });

    const before = socket.framesOfType('lock.acquire').length;
    vi.advanceTimersByTime(10_000);

    expect(socket.framesOfType('lock.acquire').length).toBeGreaterThan(before);
  });
});

describe('throttling', () => {
  it('batches a multi-item drag into one frame', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    welcome(socket);
    const items = Array.from({ length: 5 }, () => asItemId(crypto.randomUUID()));

    realtime.sendPreview(new Map(items.map((id, i) => [id, transform(i)])));
    vi.advanceTimersByTime(100);

    const previews = socket.framesOfType('transform.preview');
    expect(previews).toHaveLength(1);
    expect((previews[0] as unknown as { items: unknown[] }).items).toHaveLength(5);
  });

  it('coalesces a burst into one frame carrying the newest transform', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    welcome(socket);
    const itemId = asItemId(crypto.randomUUID());

    for (let i = 0; i < 60; i++) realtime.sendPreview(new Map([[itemId, transform(i)]]));
    vi.advanceTimersByTime(100);

    const previews = socket.framesOfType('transform.preview');
    expect(previews).toHaveLength(1);
    expect(
      (previews[0] as unknown as { items: { transform: { x: number } }[] }).items[0]?.transform.x,
    ).toBe(59);
  });
});

describe('an agent at work', () => {
  it('outlines what it touched for a moment, then lets go', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    welcome(socket);
    const agent = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    socket.deliver({
      t: 'presence',
      joined: [
        {
          actorId: agent,
          displayName: 'Claude Code',
          colourIndex: 3,
          kind: 'agent',
          person: 'Ada',
        },
      ],
    });
    socket.deliver({ t: 'focus', actorId: agent, itemId, verb: 'editing' });
    expect(realtime.presence.focus.get(agent)).toEqual({ itemId, verb: 'editing' });
    expect(realtime.presence.actors.get(agent)?.kind).toBe('agent');
    vi.advanceTimersByTime(FOCUS_MS + 1);
    expect(realtime.presence.focus.size).toBe(0);
  });

  it('keeps a newer focus when an older one times out', () => {
    vi.useFakeTimers();
    const { socket, realtime } = setup();
    welcome(socket);
    const agent = crypto.randomUUID();
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    socket.deliver({
      t: 'presence',
      joined: [{ actorId: agent, displayName: 'Claude Code', colourIndex: 3, kind: 'agent' }],
    });
    socket.deliver({ t: 'focus', actorId: agent, itemId: first, verb: 'reading' });
    vi.advanceTimersByTime(FOCUS_MS - 100);
    socket.deliver({ t: 'focus', actorId: agent, itemId: second, verb: 'reading' });
    vi.advanceTimersByTime(200);
    expect(realtime.presence.focus.get(agent)?.itemId).toBe(second);
    socket.deliver({ t: 'presence', left: [agent] });
    expect(realtime.presence.focus.size).toBe(0);
  });
});
