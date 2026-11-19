/**
 * Getting durable changes to the server, beside the interaction loop.
 *
 * North star 3: the user never saves. Invariant 6: local manipulation does not
 * wait on the network. So this is a queue, not a call — nothing in here is ever
 * awaited by a pointer handler, and a board keeps working at full speed while
 * the server is unreachable.
 *
 * It is fed by `CanvasDocument.onApplied`, which is the single funnel invariant
 * 9 already guarantees: local edits, undo, redo and an upload resolving a
 * placeholder all arrive here without any of them being wired separately.
 */

import { api } from '@visarium/api-client';
import type {
  CanvasDocument,
  CanvasItemContent,
  CanvasOperationBody,
  ItemId,
  OperationOrigin,
} from '@visarium/canvas-core';

/**
 * How long operations accumulate before being sent.
 *
 * A gesture ends with several operations in the same tick — dragging five
 * selected items is five `item.transform` bodies — and this is the difference
 * between one request and five. It is also the window in which a hard tab kill
 * loses work, which is why `flush()` runs on `visibilitychange` as well.
 *
 * A hypothesis, not a measurement: see OPEN_QUESTIONS Q11.
 */
export const FLUSH_MS = 300;

/** Retry a failing send this many times before saying so out loud. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 10_000;

export interface SyncStatus {
  /** Operations applied locally that the server has not acknowledged. */
  readonly pending: number;
  /** Persisting has failed repeatedly and is still being retried. */
  readonly failing: boolean;
}

export const SYNCED: SyncStatus = { pending: 0, failing: false };

export type OperationPoster = (
  boardId: string,
  operations: readonly CanvasOperationBody[],
  init?: { keepalive?: boolean; actorId?: string },
) => Promise<number>;

/**
 * The one conversion between canvas-core's operations and the wire.
 *
 * It exists only because canvas-core's arrays are `readonly` and the generated
 * types are not. Everything else — every field name, every discriminator value —
 * is identical by construction, and this function deliberately does NOT cast:
 * if the two ever disagree about anything real, this is where it fails to
 * typecheck rather than where a board quietly persists wrong.
 */
function wire(body: CanvasOperationBody) {
  if ('memberIds' in body) return { ...body, memberIds: [...body.memberIds] };
  if (body.type === 'item.create' || body.type === 'item.content')
    return { ...body, content: wireContent(body.content) };
  return body;
}

function wireContent(content: CanvasItemContent) {
  switch (content.kind) {
    case 'checklist':
      return { ...content, tasks: content.tasks.map((t) => ({ ...t })) };
    case 'unknown':
      // ponytail: an item of a kind this client cannot model is never written
      // back (an undo of its delete fails here and the board resyncs). Carry the
      // raw wire content through the model if that ever happens in practice.
      throw new SyncError(
        `content of kind '${content.original}' is not this client's to write`,
        400,
      );
    default:
      return content;
  }
}

/** @returns the board revision the server reached. */
export const postOperations: OperationPoster = async (boardId, operations, init) => {
  const { data, error, response } = await api.POST('/api/boards/{id}/operations', {
    params: {
      path: { id: boardId },
      // Names the socket that posted, so the server's broadcast can skip us: we
      // learn the revision from this very response and do not want our own
      // edits echoed back. Absent when there is no socket, and then the server
      // tells everybody — which is correct, because there is no "us" to skip.
      ...(init?.actorId ? { header: { 'X-Visarium-Actor': init.actorId } } : {}),
    },
    body: {
      operations: operations.map((body) => ({
        // ADR-0011's idempotency key. Nothing stores it — idempotency here is
        // structural, because every body carries absolute state — but it is
        // what correlates a retry with what it retries.
        operationId: crypto.randomUUID(),
        baseRevision: 0,
        body: wire(body),
      })),
    },
    ...(init?.keepalive ? { keepalive: true } : {}),
  });

  if (!data || typeof data.revision !== 'number') {
    // The server's own words when it gave any (a problem document's detail):
    // "stale edit: based on revision 3, the item is at revision 4" says what a
    // bare 409 does not.
    const detail = (error as { detail?: unknown } | undefined)?.detail;
    throw new SyncError(
      typeof detail === 'string' ? detail : `could not persist operations: ${response.status}`,
      response.status,
    );
  }
  return data.revision;
};

/** What became of a posted batch. */
export type PostOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly status: number; readonly message: string };

export class SyncError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A 4xx will not succeed on the tenth attempt either.
 *
 * Retrying it forever would be a hot loop against a server that has already
 * explained itself, so a rejected batch is dropped and reported. 408 and 429 are
 * the exceptions: both mean "later", not "no".
 */
function permanent(cause: unknown): boolean {
  if (!(cause instanceof SyncError)) return false;
  return cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429;
}

const itemOf = (body: CanvasOperationBody): ItemId | undefined =>
  'itemId' in body ? body.itemId : undefined;

export class BoardSync {
  readonly #boardId: string;
  readonly #doc: CanvasDocument;
  readonly #post: OperationPoster;
  readonly #flushMs: number;
  readonly #onStatus: (status: SyncStatus) => void;

  #queue: CanvasOperationBody[] = [];
  /**
   * Items the server cannot hold yet.
   *
   * A `placeholder` has no asset id and `canvas_item.asset_id` is NOT NULL, so
   * a freshly dropped item is not sent until its upload resolves. Everything
   * that happens to it in the meantime is dropped rather than queued, because
   * the creation eventually sent is built from the item's state at that moment
   * and already carries the result.
   */
  readonly #deferred = new Set<ItemId>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = false;
  #failures = 0;
  #stopped = false;
  /** Resolved when the queue next drains. See {@link settled}. */
  #settling: (() => void)[] = [];
  /** Who we are on the socket, when there is one. Passed on every post. */
  #actorId: string | undefined;
  readonly #onPosted:
    | ((batch: readonly CanvasOperationBody[], outcome: PostOutcome) => void)
    | undefined;

  constructor(options: {
    boardId: string;
    doc: CanvasDocument;
    post?: OperationPoster;
    flushMs?: number;
    onStatus?: (status: SyncStatus) => void;
    /** Each batch's fate, for a dev build's operation log. */
    onPosted?: (batch: readonly CanvasOperationBody[], outcome: PostOutcome) => void;
  }) {
    this.#onPosted = options.onPosted;
    this.#boardId = options.boardId;
    this.#doc = options.doc;
    this.#post = options.post ?? postOperations;
    this.#flushMs = options.flushMs ?? FLUSH_MS;
    this.#onStatus = options.onStatus ?? (() => {});
  }

  get status(): SyncStatus {
    return { pending: this.#queue.length, failing: this.#failures >= ATTEMPTS };
  }

  /** Tell the queue who it is, once the socket has been welcomed. */
  setActorId(actorId: string | undefined): void {
    this.#actorId = actorId;
  }

  /**
   * Resolves once everything queued has been posted.
   *
   * This exists for locks. A gesture's claim is held until its operations are
   * DURABLE, not until the pointer goes up: in between, the item's committed
   * state is still the old one, and someone who grabbed it in that window could
   * have their commit overwritten by the one still sitting in this queue.
   *
   * If persistence is failing this never resolves, and that is correct — the
   * ~10 s lock expiry is the backstop, and it is better for an item to stay
   * briefly ungrabbable than for an edit to be quietly lost.
   */
  settled(): Promise<void> {
    if (this.#queue.length === 0 && !this.#inFlight) return Promise.resolve();
    return new Promise((resolve) => this.#settling.push(resolve));
  }

  /**
   * The `CanvasDocument.onApplied` listener. Never throws, never blocks.
   *
   * A remote operation is skipped: it arrived already committed from another
   * client, and sending it back would be this client claiming someone else's
   * edit — and bumping the revision a second time for one change.
   */
  readonly applied = (body: CanvasOperationBody, origin: OperationOrigin = 'local'): void => {
    if (origin === 'remote') return;
    for (const durable of this.#durable(body)) this.#queue.push(durable);
    this.#report();
    this.#schedule();
  };

  /**
   * Translate one applied operation into what the server should be told.
   *
   * Usually itself. The exceptions are all about items that are not yet
   * persistable, and they are the reason this is a function rather than a push.
   */
  #durable(body: CanvasOperationBody): CanvasOperationBody[] {
    if (body.type === 'item.create') {
      if (body.content.kind === 'placeholder') {
        this.#deferred.add(body.itemId);
        return [];
      }
      return [body];
    }

    const itemId = itemOf(body);
    if (itemId === undefined || !this.#deferred.has(itemId)) return [body];

    // Below here the item is deferred: the server has never heard of it.
    if (body.type === 'item.delete') {
      // Undone or deleted before its upload landed. Nothing was ever sent, so
      // nothing needs unsending — and the asset stays stored, because assets
      // outlive boards.
      this.#deferred.delete(itemId);
      return [];
    }

    if (body.type === 'item.content' && body.content.kind === 'image') {
      this.#deferred.delete(itemId);
      const item = this.#doc.item(itemId);
      if (item?.content.kind !== 'image') return [];
      // One creation carrying where the item actually is now, which may be
      // nowhere near where it was dropped: it was draggable the whole time.
      return [
        {
          type: 'item.create',
          itemId: item.id,
          transform: item.transform,
          z: item.z,
          content: item.content,
          // Named, like every other field on this literal — and this is the one
          // that fails silently. An opacity set while the image was uploading
          // has nowhere else to travel: the operation that set it was dropped
          // below as "the creation carries the result of all of it", so if the
          // creation does not carry it, nothing does and nothing says so.
          appearance: item.appearance,
          ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
        },
      ];
    }

    // Moved, resized or reordered while still uploading. Dropped, not queued:
    // the creation above carries the result of all of it.
    return [];
  }

  #schedule(): void {
    if (this.#stopped || this.#timer !== undefined || this.#queue.length === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#flushMs);
  }

  /**
   * Send everything queued.
   *
   * @param keepalive for the `visibilitychange` flush, where the page may be
   *   discarded before the response arrives.
   */
  async flush(keepalive = false): Promise<void> {
    if (this.#inFlight || this.#queue.length === 0) return;
    this.#inFlight = true;
    const batch = this.#queue;
    this.#queue = [];
    this.#report();

    try {
      const revision = await this.#post(this.#boardId, batch, {
        keepalive,
        ...(this.#actorId ? { actorId: this.#actorId } : {}),
      });
      this.#doc.setRevision(revision);
      this.#failures = 0;
      this.#onPosted?.(batch, { ok: true, revision });
    } catch (cause) {
      if (permanent(cause)) {
        this.#onPosted?.(batch, {
          ok: false,
          status: (cause as SyncError).status,
          message: (cause as Error).message,
        });
        // The server has refused this batch and will refuse it again. Keeping
        // it would block every operation behind it forever.
        this.#failures = ATTEMPTS;
      } else {
        // Back at the front: order is the whole reason a queue is correct here.
        this.#queue = [...batch, ...this.#queue];
        this.#failures += 1;
        this.#retry();
      }
    } finally {
      this.#inFlight = false;
      this.#report();
      this.#schedule();
      this.#notifySettled();
    }
  }

  /** Everything queued is durable — release whatever was waiting on that. */
  #notifySettled(): void {
    if (this.#queue.length > 0 || this.#inFlight) return;
    const waiting = this.#settling;
    this.#settling = [];
    for (const resolve of waiting) resolve();
  }

  #retry(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    const delay = Math.min(RETRY_DELAY_MS * 2 ** (this.#failures - 1), MAX_RETRY_DELAY_MS);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delay);
  }

  /** Stop scheduling. Anything queued is still sent by an explicit `flush`. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #report(): void {
    this.#onStatus(this.status);
  }
}
