/**
 * The socket, beside the interaction loop and never inside it.
 *
 * Invariant 6 shapes every method here: nothing in this file is awaited by a
 * pointer handler, and every send is fire-and-forget. Invariant 10 shapes what
 * it carries: presence, cursors, selections, in-flight previews and locks —
 * everything ephemeral, and nothing durable. Durable operations still go over
 * REST through `board-sync.ts`, and this socket only hears about them once they
 * are committed (ADR-0017).
 *
 * The consequence worth stating out loud, because it is the reason the design
 * came out this way: **losing this socket costs you other people, not your
 * work.**
 */

import {
  type CanvasDocument,
  type CanvasOperationBody,
  type ItemId,
  PROTOCOL_VERSION,
  type PresenceActor,
  type ServerMessage,
  type Transform,
} from '@visarium/canvas-core';
import { parseServerMessage } from './realtime-frames';

/**
 * How often cursors and in-flight transforms go out, at most.
 *
 * 20 Hz. Remote motion is interpolated on the receiving side, and a viewer
 * cannot tell 20 Hz smoothed from 60 Hz raw — while the sender pays three times
 * the frames for the privilege. This is Q4's starting point, and Q4 is settled
 * by measuring the RECEIVING side with three clients, because the sender always
 * looks fine: invariant 6 means it never waits.
 */
export const THROTTLE_MS = 50;

/**
 * How often a held gesture re-states its claim.
 *
 * Locks expire after ~10 s and are refreshed by preview traffic — but a pointer
 * held still sends no previews, so a paused gesture would silently lose its
 * grip. Re-acquiring is idempotent for the holder, so the heartbeat reuses a
 * message that already exists rather than inventing a frame type for it.
 */
const LOCK_HEARTBEAT_MS = 3_000;

/** Reconnection backs off to at most this. A self-hosted server is usually back in seconds. */
/**
 * How many selected items another client is told about.
 *
 * Select-all on the 100,000-item board is a real gesture, and a selection frame
 * naming every one of them would cost the receiver a stroked rectangle each.
 */
const MAX_BROADCAST_SELECTION = 200;

const MAX_RECONNECT_MS = 10_000;
const BASE_RECONNECT_MS = 500;

export interface RemotePresence {
  readonly actors: ReadonlyMap<string, PresenceActor>;
  readonly cursors: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly selections: ReadonlyMap<string, readonly ItemId[]>;
  /** In-flight transforms by item, with who is doing it. Never in the document. */
  readonly previews: ReadonlyMap<
    ItemId,
    { readonly actorId: string; readonly transform: Transform }
  >;
  /** Who holds what. Includes our own claims, so the renderer can tell them apart. */
  readonly locks: ReadonlyMap<ItemId, string>;
  /** What each agent last read or changed, for FOCUS_MS (ADR-0031). */
  readonly focus: ReadonlyMap<string, { readonly itemId: ItemId; readonly verb: string }>;
}

/** How long an agent's focus outline stays on an item. */
export const FOCUS_MS = 4_000;

export type ConnectionState = 'connecting' | 'live' | 'offline';

const EMPTY_PRESENCE: RemotePresence = {
  actors: new Map(),
  cursors: new Map(),
  selections: new Map(),
  previews: new Map(),
  locks: new Map(),
  focus: new Map(),
};

export { EMPTY_PRESENCE };

/** Whether any agent on the board has a live focus: it just read or changed something. */
export function agentIsWorking(presence: RemotePresence): boolean {
  for (const id of presence.focus.keys()) {
    if (presence.actors.get(id)?.kind === 'agent') return true;
  }
  return false;
}

/*
 * There is no display name in this file any more.
 *
 * M05 kept one in `localStorage` and sent it in `hello`, explicitly as a
 * placeholder. M06 gave it a subject: an actor is named by their ACCOUNT, the
 * server reads that name from the authenticated handshake, and a client cannot
 * assert one. So the storage key, its two accessors and the `hello` field are
 * all gone rather than left as a value nothing reads.
 */

export interface RealtimeOptions {
  boardId: string;
  doc: CanvasDocument;
  /** Fetches a fresh snapshot and loads it. The gap-recovery path — ADR-0011, never replay. */
  resync: () => Promise<void>;
  onPresence: (presence: RemotePresence) => void;
  onState: (state: ConnectionState) => void;
  /** Called when a remote operation changed the document, so the renderer can redraw. */
  onRemoteChange: () => void;
  /**
   * Items this client optimistically grabbed and was refused.
   *
   * The gesture already started — waiting for a grant would be invariant 6 — so
   * the caller returns these to their last committed state and stops
   * manipulating them.
   */
  onLockRefused?: (itemIds: readonly ItemId[]) => void;
  /** How many share-link viewers have the board open (ADR-0026). */
  onViewers?: (count: number) => void;
  /** Someone renamed the board while it was open. */
  onRenamed?: (title: string, by: string) => void;
  /** Someone deleted the board while it was open. */
  onDeleted?: (by: string) => void;
  /**
   * The socket's path. A share-link viewer's is `/ws/shared`, which hears
   * committed operations and nothing else; a member's is the board's own.
   */
  path?: string;
  /** Test seam. */
  socketFactory?: (url: string) => WebSocket;
}

export class BoardRealtime {
  readonly #options: RealtimeOptions;
  #socket: WebSocket | undefined;
  #actorId: string | undefined;
  #closed = false;
  #attempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Frames that did not parse. Not fatal, but a bug worth being able to see. */
  #dropped = 0;

  #actors = new Map<string, PresenceActor>();
  #cursors = new Map<string, { x: number; y: number }>();
  #selections = new Map<string, readonly ItemId[]>();
  #previews = new Map<ItemId, { actorId: string; transform: Transform }>();
  #focus = new Map<string, { itemId: ItemId; verb: string }>();
  #locks = new Map<ItemId, string>();

  /** Items this client currently claims, re-stated on the heartbeat. */
  #held = new Set<ItemId>();

  #lastCursorAt = 0;
  #lastPreviewAt = 0;
  #pendingPreview: Map<ItemId, Transform> | undefined;
  #previewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RealtimeOptions) {
    this.#options = options;
  }

  get actorId(): string | undefined {
    return this.#actorId;
  }

  get droppedFrames(): number {
    return this.#dropped;
  }

  get presence(): RemotePresence {
    return {
      actors: this.#actors,
      cursors: this.#cursors,
      selections: this.#selections,
      previews: this.#previews,
      focus: this.#focus,
      locks: this.#locks,
    };
  }

  connect(): void {
    if (this.#closed) return;
    this.#options.onState(this.#attempts === 0 ? 'connecting' : 'offline');

    const url = new URL(
      this.#options.path ?? `/ws/canvas/${this.#options.boardId}`,
      globalThis.location?.href ?? 'http://localhost',
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = this.#options.socketFactory
      ? this.#options.socketFactory(url.toString())
      : new WebSocket(url.toString());
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempts = 0;
      this.#send({
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        canvasId: this.#options.boardId,
        sinceRevision: this.#options.doc.revision,
      });
      this.#heartbeat = setInterval(() => this.#refreshHeld(), LOCK_HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      const frame = typeof event.data === 'string' ? parseServerMessage(event.data) : null;
      if (!frame) {
        // Dropped and counted. Closing here would hide our own bug behind a
        // reconnect that looks like a network blip.
        this.#dropped += 1;
        return;
      }
      this.#handle(frame);
    };

    socket.onclose = () => {
      this.#stopHeartbeat();
      this.#actorId = undefined;
      this.#forgetEveryone();
      if (this.#closed) return;
      this.#options.onState('offline');
      this.#scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where reconnection lives.
    };
  }

  close(): void {
    this.#closed = true;
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    if (this.#previewTimer !== undefined) clearTimeout(this.#previewTimer);
    this.#socket?.close();
    this.#socket = undefined;
  }

  // --- outbound -----------------------------------------------------------

  /** Throttled. Called from pointermove, so it must cost nothing. */
  sendCursor(x: number, y: number): void {
    const now = Date.now();
    if (now - this.#lastCursorAt < THROTTLE_MS) return;
    this.#lastCursorAt = now;
    this.#send({ t: 'cursor', x, y });
  }

  sendSelection(itemIds: readonly ItemId[]): void {
    // Bounded, because select-all exists. Another actor's selection is drawn as
    // one stroked rectangle per item, so an unbounded frame would cost the
    // receiver the frame budget the active set exists to protect — and a
    // hundred thousand marks are not information anybody can read anyway. The
    // marks say where someone is working; they are not an inventory.
    this.#send({ t: 'selection', itemIds: [...itemIds].slice(0, MAX_BROADCAST_SELECTION) });
  }

  /**
   * An in-flight gesture, coalesced.
   *
   * Every item moved in this window goes in ONE frame — a five-item drag is one
   * message, not five — and the last transform for an item wins, because a
   * preview carries whole state and the newest is the only one worth sending.
   */
  sendPreview(items: ReadonlyMap<ItemId, Transform> | Iterable<[ItemId, Transform]>): void {
    const pending = this.#pendingPreview ?? new Map<ItemId, Transform>();
    for (const [itemId, transform] of items) pending.set(itemId, transform);
    this.#pendingPreview = pending;

    const now = Date.now();
    const wait = Math.max(0, THROTTLE_MS - (now - this.#lastPreviewAt));
    if (this.#previewTimer !== undefined) return;
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = undefined;
      this.#flushPreview();
    }, wait);
  }

  #flushPreview(): void {
    const pending = this.#pendingPreview;
    this.#pendingPreview = undefined;
    if (!pending || pending.size === 0) return;
    this.#lastPreviewAt = Date.now();
    this.#send({
      t: 'transform.preview',
      items: [...pending].map(([itemId, transform]) => ({ itemId, transform })),
    });
  }

  /** Claim items. Optimistic by design: the caller does not wait for the answer. */
  acquire(itemIds: readonly ItemId[]): void {
    if (itemIds.length === 0) return;
    for (const id of itemIds) this.#held.add(id);
    this.#send({ t: 'lock.acquire', itemIds: [...itemIds] });
  }

  release(itemIds: readonly ItemId[]): void {
    if (itemIds.length === 0) return;
    for (const id of itemIds) this.#held.delete(id);
    this.#send({ t: 'lock.release', itemIds: [...itemIds] });
  }

  /** Whoever holds this item, if it is not us. `undefined` means it is grabbable. */
  heldByOther(itemId: ItemId): string | undefined {
    const holder = this.#locks.get(itemId);
    if (holder === undefined || holder === this.#actorId) return undefined;
    return holder;
  }

  #refreshHeld(): void {
    if (this.#held.size === 0) return;
    this.#send({ t: 'lock.acquire', itemIds: [...this.#held] });
  }

  #send(frame: unknown): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A send that fails is a socket that is going away; `onclose` handles it.
    }
  }

  // --- inbound ------------------------------------------------------------

  #handle(frame: ServerMessage): void {
    switch (frame.t) {
      case 'welcome': {
        this.#actorId = frame.actorId;
        this.#actors = new Map(frame.actors.map((a) => [a.actorId as string, a]));
        this.#options.onState('live');
        // The board may have moved on while we were away. `welcome` carries
        // where it actually is, and anything other than agreement is a resync.
        if (frame.revision !== this.#options.doc.revision) void this.#options.resync();
        this.#publish();
        return;
      }
      case 'presence': {
        const actors = new Map(this.#actors);
        for (const joined of frame.joined ?? []) actors.set(joined.actorId as string, joined);
        for (const left of frame.left ?? []) {
          actors.delete(left as string);
          this.#forget(left as string);
        }
        this.#actors = actors;
        this.#publish();
        return;
      }
      case 'focus': {
        const focus = { itemId: frame.itemId, verb: frame.verb };
        this.#focus = new Map(this.#focus).set(frame.actorId as string, focus);
        this.#publish();
        // Gone after a moment, unless the agent has moved on to something else.
        setTimeout(() => {
          if (this.#focus.get(frame.actorId as string) !== focus) return;
          this.#focus = new Map([...this.#focus].filter(([id]) => id !== frame.actorId));
          this.#publish();
        }, FOCUS_MS);
        return;
      }
      case 'cursor': {
        this.#cursors = new Map(this.#cursors).set(frame.actorId as string, {
          x: frame.x,
          y: frame.y,
        });
        this.#publish();
        return;
      }
      case 'selection': {
        this.#selections = new Map(this.#selections).set(frame.actorId as string, frame.itemIds);
        this.#publish();
        return;
      }
      case 'transform.preview': {
        const previews = new Map(this.#previews);
        for (const item of frame.items) {
          previews.set(item.itemId, {
            actorId: frame.actorId as string,
            transform: item.transform,
          });
        }
        this.#previews = previews;
        this.#publish();
        return;
      }
      case 'lock': {
        const locks = new Map(this.#locks);
        for (const itemId of frame.itemIds) {
          if (frame.heldBy === null) locks.delete(itemId);
          else locks.set(itemId, frame.heldBy as string);
        }
        // A refusal is the server telling us someone else has it, so stop
        // claiming it — otherwise the heartbeat would ask forever — and tell the
        // gesture, which started optimistically and now has to give the item up.
        if (frame.heldBy !== null && frame.heldBy !== this.#actorId) {
          const refused = frame.itemIds.filter((id) => this.#held.delete(id));
          if (refused.length > 0) this.#options.onLockRefused?.(refused);
        }
        this.#locks = locks;
        this.#publish();
        return;
      }
      case 'op':
        this.#applyCommitted(frame);
        return;
      case 'resync':
        void this.#options.resync();
        return;
      case 'viewers':
        this.#options.onViewers?.(frame.count);
        return;
      case 'board':
        this.#options.onRenamed?.(frame.title, frame.by);
        return;
      case 'board-deleted':
        this.#options.onDeleted?.(frame.by);
        return;
    }
  }

  /**
   * Apply what the server already committed.
   *
   * Two comparisons decide everything, which is the whole reason the frame
   * carries a range rather than a per-operation revision: a frame ending at or
   * below what we hold is a duplicate, and one beginning above it is a gap. A
   * gap is a snapshot refetch, never a replay (ADR-0011).
   */
  #applyCommitted(frame: Extract<ServerMessage, { t: 'op' }>): void {
    const doc = this.#options.doc;
    if (frame.toRevision <= doc.revision) return;
    if (frame.fromRevision !== doc.revision) {
      void this.#options.resync();
      return;
    }

    let changed = false;
    for (const body of frame.operations) {
      // Remote: `board-sync` must not echo it back, and it must not enter this
      // client's undo stack — undo is for what you did.
      if (doc.apply(body as CanvasOperationBody, 'remote')) changed = true;
    }
    doc.setRevision(frame.toRevision);

    // A committed transform supersedes any preview for the same item: the
    // gesture is over, and the document is now the truth.
    if (frame.operations.length > 0) {
      const previews = new Map(this.#previews);
      let dropped = false;
      for (const body of frame.operations) {
        const itemId = (body as { itemId?: ItemId }).itemId;
        if (itemId !== undefined && previews.delete(itemId)) dropped = true;
      }
      if (dropped) {
        this.#previews = previews;
        this.#publish();
      }
    }

    if (changed) this.#options.onRemoteChange();
  }

  #forget(actorId: string): void {
    this.#cursors = new Map([...this.#cursors].filter(([id]) => id !== actorId));
    this.#selections = new Map([...this.#selections].filter(([id]) => id !== actorId));
    this.#previews = new Map([...this.#previews].filter(([, p]) => p.actorId !== actorId));
    this.#locks = new Map([...this.#locks].filter(([, holder]) => holder !== actorId));
    this.#focus = new Map([...this.#focus].filter(([id]) => id !== actorId));
  }

  #forgetEveryone(): void {
    this.#actors = new Map();
    this.#cursors = new Map();
    this.#selections = new Map();
    this.#previews = new Map();
    this.#locks = new Map();
    this.#focus = new Map();
    this.#held.clear();
    this.#publish();
  }

  #publish(): void {
    this.#options.onPresence(this.presence);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined) return;
    this.#attempts += 1;
    const delay = Math.min(BASE_RECONNECT_MS * 2 ** (this.#attempts - 1), MAX_RECONNECT_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
