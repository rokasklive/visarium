/**
 * The realtime wire protocol — TYPES ONLY.
 *
 * These declarations are the shared contract between the browser and the server's
 * WebSocket handler. They live in canvas-core because they are pure data and
 * carry {@link CanvasOperationBody}, which canvas-core already owns.
 *
 * What this protocol does NOT carry is a durable write. M03 built the durable
 * path as `POST /api/boards/{id}/operations` — batched, atomic, ordered and
 * idempotent by construction (ADR-0017) — and M05 kept it there rather than
 * growing a second one over the socket. So the socket's `op` frame travels one
 * way only: the server announcing what it has already committed. A client that
 * misses one does not ask for it again, it refetches the snapshot (ADR-0011).
 *
 * Evolution rule: `PROTOCOL_VERSION` is bumped for any incompatible change.
 * Adding an OPTIONAL field to an existing message is compatible; anything else
 * is not. A client whose version the server does not accept is told to reload
 * rather than negotiated with — a self-hosted deployment ships both halves
 * together, so version skew is a deploy-window artefact, not a permanent state.
 *
 * M06 REMOVED `displayName` from `hello` and PROTOCOL_VERSION STAYED AT 1.
 * That is the same rule read in the other direction: removing an optional field
 * that the server has stopped reading is compatible, because an old cached tab
 * that still sends one is ignored rather than rejected. An actor's name now
 * comes from their account and the client cannot assert one, so there is nothing
 * for a version bump to protect — and bumping it would force a reload on every
 * open tab to change a field nobody reads.
 *
 * M08 ADDED two operation types — `item.appearance` and `group.label` — and
 * PROTOCOL_VERSION MOVED TO 2, the first time it has moved. That is the rule
 * read the ordinary way, and the reason to be strict about it is the failure
 * mode of not being: `parseServerMessage` rejects a frame carrying an operation
 * type it does not know, and it rejects the WHOLE frame, because a frame is
 * either entirely trustworthy or it is dropped. An old tab left at 1 would
 * therefore hold a revision below the board's, see a gap on the next frame, and
 * a gap is a snapshot refetch — so it would resync, silently, on every
 * appearance change anybody made, forever, and the only symptom would be
 * traffic. Bumping costs a reload on tabs open across a deploy; not bumping
 * costs a client that never says it is broken.
 *
 * The annotated-outlines change ADDED `group.frame` and PROTOCOL_VERSION MOVED
 * TO 3 for the same reason M08's two did: a new operation type is the
 * incompatible case, whatever else rides along with it.
 *
 * Collision ADDED `item.collides` and `group.collides` and PROTOCOL_VERSION
 * MOVED TO 4, by the same rule.
 *
 * `item.create` gaining an optional `appearance` is, separately, exactly the
 * compatible case: a client that sends none is still understood, and the server
 * defaults it.
 */

import type { Transform } from './geometry';
import type { ActorId, CanvasId, ItemId } from './ids';
import type { CanvasOperationBody } from './operations';

export const PROTOCOL_VERSION = 4;

/**
 * How many actors can be told apart by colour.
 *
 * The wire carries a slot index rather than a colour, because the design system
 * permits no colour literal to enter the product from anywhere but the token
 * file — a socket included. Both ends agree on this count: the server assigns
 * within it, the client has exactly this many `--presence-*` tokens.
 *
 * It is also the concurrency ceiling made visible. North star 9 says two or
 * three people, not a thousand; six is that with room to be wrong.
 */
export const PRESENCE_COLOUR_SLOTS = 6;

/** The longest item-id array any frame may carry. Bounded because it is parsed from untrusted input. */
export const MAX_FRAME_ITEMS = 1024;

export interface PresenceActor {
  readonly actorId: ActorId;
  /**
   * The account's display name, decided by the server at the handshake.
   *
   * A client cannot claim one: it is read from the authenticated session, not
   * from `hello`. So this is the one thing on the wire that is a fact about a
   * person rather than a label they typed.
   */
  readonly displayName: string;
  /** Index into the presence colour tokens, `0 .. PRESENCE_COLOUR_SLOTS - 1`. Never a colour value. */
  readonly colourIndex: number;
  /**
   * `agent` for an AI agent working through `/mcp` (ADR-0031): present while
   * its calls keep coming, with no cursor. Absent for a person.
   */
  readonly kind?: 'agent';
  /** For an agent, the display name of the person it acts for. */
  readonly person?: string;
}

/** One item's in-flight transform. A multi-item gesture sends these together in one frame. */
export interface PreviewItem {
  readonly itemId: ItemId;
  readonly transform: Transform;
}

/** Browser → server. */
export type ClientMessage =
  | {
      readonly t: 'hello';
      readonly protocolVersion: number;
      readonly canvasId: CanvasId;
      readonly sinceRevision: number;
    }
  /** Ephemeral. Throttled, never persisted. */
  | { readonly t: 'cursor'; readonly x: number; readonly y: number }
  | { readonly t: 'selection'; readonly itemIds: readonly ItemId[] }
  /**
   * Ephemeral in-flight drag/resize, batched across the whole gesture.
   *
   * Carries whole transforms rather than deltas, so a dropped frame is corrected
   * by the next one instead of leaving permanent error. Superseded by the
   * durable commit, which arrives over REST.
   */
  | { readonly t: 'transform.preview'; readonly items: readonly PreviewItem[] }
  | { readonly t: 'lock.acquire'; readonly itemIds: readonly ItemId[] }
  | { readonly t: 'lock.release'; readonly itemIds: readonly ItemId[] }
  /** This client opened or closed these apps' views (canvas/apps): it can run them. */
  | { readonly t: 'app.mounted'; readonly itemIds: readonly ItemId[] }
  | { readonly t: 'app.unmounted'; readonly itemIds: readonly ItemId[] }
  /** Asks to run these apps: one client at a time may, for the inputs as they are. */
  | { readonly t: 'run.request'; readonly itemIds: readonly ItemId[] };

/** Server → browser. */
export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly actorId: ActorId;
      readonly revision: number;
      /** Everyone on the board, this actor included — find yourself by `actorId`. */
      readonly actors: readonly PresenceActor[];
    }
  | {
      readonly t: 'presence';
      readonly joined?: readonly PresenceActor[];
      readonly left?: readonly ActorId[];
    }
  | { readonly t: 'cursor'; readonly actorId: ActorId; readonly x: number; readonly y: number }
  | { readonly t: 'selection'; readonly actorId: ActorId; readonly itemIds: readonly ItemId[] }
  | {
      readonly t: 'transform.preview';
      readonly actorId: ActorId;
      readonly items: readonly PreviewItem[];
    }
  /**
   * Operations the server has already committed, announced to everyone else.
   *
   * Apply only when `fromRevision` equals the revision you hold, then advance to
   * `toRevision`. A frame ending at or below what you hold is a duplicate and is
   * dropped; one beginning above it is a gap, and a gap is a snapshot refetch,
   * never a replay. Two comparisons, no arithmetic to get wrong.
   */
  | {
      readonly t: 'op';
      readonly fromRevision: number;
      readonly toRevision: number;
      readonly operations: readonly CanvasOperationBody[];
    }
  | {
      readonly t: 'lock';
      readonly itemIds: readonly ItemId[];
      readonly heldBy: ActorId | null;
      readonly expiresAt: number;
    }
  /** Who runs an app now (canvas/apps): only that client's outputs commit, until `until`. */
  | {
      readonly t: 'run.lease';
      readonly itemId: ItemId;
      readonly holder: ActorId;
      readonly until: number;
    }
  /** The run is over: committed, superseded, lapsed or its holder left. */
  | { readonly t: 'run.end'; readonly itemId: ItemId }
  /** To the requester: someone else is running it. */
  | { readonly t: 'run.busy'; readonly itemId: ItemId; readonly holder: ActorId }
  /** To the requester: nobody has the app open to run it. */
  | { readonly t: 'run.none'; readonly itemId: ItemId }
  /** To the requester: its output already matches its inputs; nothing to run. */
  | { readonly t: 'run.done'; readonly itemId: ItemId }
  /** The client is too far behind to catch up. Refetch the snapshot over REST. */
  | { readonly t: 'resync'; readonly revision: number }
  /**
   * How many people have the board open through a read-only share link
   * (ADR-0026). Members hear the count and nothing else about them; viewers
   * have no presence, no cursor and no name.
   */
  | { readonly t: 'viewers'; readonly count: number }
  /**
   * What an agent just read or changed (ADR-0031). The item is outlined in the
   * agent's colour for a moment. Never carries the item's content.
   */
  | {
      readonly t: 'focus';
      readonly actorId: ActorId;
      readonly itemId: ItemId;
      readonly verb: 'reading' | 'editing';
    }
  /** The board was renamed; `by` names who did ("Claude for Rokas"). Members only. */
  | { readonly t: 'board'; readonly title: string; readonly by: string }
  /** The board was deleted, by `by`. Members only; viewers are disconnected. */
  | { readonly t: 'board-deleted'; readonly by: string };
