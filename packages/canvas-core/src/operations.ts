/**
 * Canvas operations.
 *
 * Every durable change to a canvas — local or remote, optimistic or replayed —
 * is one of these. Nothing mutates a {@link CanvasDocument} by any other route.
 * That single funnel is what later makes undo, collaboration, replay and audit
 * possible without redesigning the model.
 *
 *   local input ─┐
 *                ├─▶ CanvasOperation ─▶ applyOperation ─▶ document
 *   remote event ┘                   └─▶ send to server (local only)
 *
 * Operations are self-contained values: serialisable, idempotent by
 * `operationId`, and carrying enough state to be inverted.
 */

import type { Transform } from './geometry';
import type { ActorId, CanvasId, GroupId, ItemId, LinkId, OperationId } from './ids';
import type {
  Anchor,
  Appearance,
  AppOutput,
  AppRunMode,
  CanvasItemContent,
  Centerpiece,
  Crop,
  LinkType,
  Task,
  TaskState,
} from './model';

export type CanvasOperationBody =
  | {
      readonly type: 'item.create';
      readonly itemId: ItemId;
      readonly transform: Transform;
      readonly z: number;
      readonly content: CanvasItemContent;
      readonly groupId?: GroupId;
      /**
       * Optional, so a body without one is still valid — an older client's
       * creation, and every fixture written before appearance existed.
       *
       * It is carried at all because two creations are rebuilt field by field
       * from an item that already has an appearance: the one that inverts a
       * delete, and the deferred one `BoardSync` sends when an upload lands.
       * Without it, fading an image while it uploads loses the fade silently.
       */
      readonly appearance?: Appearance;
      /** Optional for the same reasons as `appearance`; absent is uncropped. */
      readonly crop?: Crop;
      /** Absent is off: a person's creation, or one from an older client. */
      readonly collides?: boolean;
      /** Absent is 1 (canvas/text-scaling). */
      readonly textScale?: number;
    }
  | { readonly type: 'item.delete'; readonly itemId: ItemId }
  | {
      readonly type: 'item.transform';
      readonly itemId: ItemId;
      readonly transform: Transform;
      /**
       * Absent means "leave the crop as it is", so every move, resize and nudge
       * stays crop-unaware. Present is absolute. It rides here rather than in an
       * op of its own because moving a crop edge moves the centre too, and the
       * two must never be applied apart. ADR-0029.
       */
      readonly crop?: Crop;
      /**
       * Absent leaves the text scale alone; present (1 included) replaces it.
       * With the transform for the same reason as crop: a corner resize of a
       * note scales its box and its text together, never one without the other.
       */
      readonly textScale?: number;
      /** Set only by the server on its own collision moves (canvas/layout-settling). */
      readonly settled?: boolean;
    }
  /** Resolves a local placeholder into a persisted image once its upload lands. */
  | {
      readonly type: 'item.content';
      readonly itemId: ItemId;
      readonly content: CanvasItemContent;
    }
  | { readonly type: 'item.z'; readonly itemId: ItemId; readonly z: number }
  /** Absolute state, like every other body: the whole appearance, not a difference. */
  | {
      readonly type: 'item.appearance';
      readonly itemId: ItemId;
      readonly appearance: Appearance;
    }
  | {
      readonly type: 'group.create';
      readonly groupId: GroupId;
      readonly memberIds: readonly ItemId[];
      readonly label?: string;
      /** Optional so older creations stay valid; carried so duplicate keeps a copy's framing in one batch. */
      readonly frame?: boolean;
      /** Absent is off, as for `item.create`. */
      readonly collides?: boolean;
    }
  | { readonly type: 'group.delete'; readonly groupId: GroupId }
  | {
      readonly type: 'group.members';
      readonly groupId: GroupId;
      readonly memberIds: readonly ItemId[];
    }
  /**
   * Rename a group.
   *
   * `group.create` cannot serve this: it is `ON CONFLICT (id) DO NOTHING` on the
   * server and returns `undefined` for an existing group in the document, so it
   * is defined to do nothing to a group that already exists.
   */
  | { readonly type: 'group.label'; readonly groupId: GroupId; readonly label: string }
  /**
   * Frame or unframe a group — the annotation outline the renderer derives from
   * member bounds. Absolute state, like every other body: the inverse of
   * "frame it" is "unframe it", never an omission.
   */
  | { readonly type: 'group.frame'; readonly groupId: GroupId; readonly frame: boolean }
  /** Turn collision on or off (canvas/collision). Absolute state, like `group.frame`. */
  | { readonly type: 'item.collides'; readonly itemId: ItemId; readonly collides: boolean }
  | { readonly type: 'group.collides'; readonly groupId: GroupId; readonly collides: boolean }
  /**
   * Replace a note's or diagram's source. `baseRevision` is the item revision
   * the edit started from; the server refuses a mismatch (409) rather than let
   * a stale editor overwrite newer text. Inverses never carry one: undo is
   * deliberate.
   */
  | {
      readonly type: 'item.source';
      readonly itemId: ItemId;
      readonly source: string;
      readonly baseRevision?: number;
    }
  | { readonly type: 'checklist.title'; readonly itemId: ItemId; readonly title: string }
  /** Insert a task at `index` (clamped), or append without one. */
  | {
      readonly type: 'task.add';
      readonly itemId: ItemId;
      readonly task: Task;
      readonly index?: number;
    }
  /**
   * Change one task. Absent fields are left alone, so marking a task done never
   * rewrites its text, and undoing it never touches another task.
   */
  | {
      readonly type: 'task.set';
      readonly itemId: ItemId;
      readonly taskId: string;
      readonly text?: string;
      readonly state?: TaskState;
      /** Stamped by the server; whatever a client sends is replaced. */
      readonly by?: string | null;
      readonly byAgent?: string | null;
      /**
       * The app whose run proposes this change (canvas/apps); accepted only from
       * the client holding that run. Absent clears it, as the server does.
       */
      readonly byApp?: string;
      readonly at?: string | null;
    }
  | { readonly type: 'task.remove'; readonly itemId: ItemId; readonly taskId: string }
  | {
      readonly type: 'link.add';
      readonly linkId: LinkId;
      readonly from: Anchor;
      readonly to: Anchor;
      readonly linkType: LinkType;
      /** A `feeds` link's view; required there, absent on every other type. */
      readonly view?: string;
      /** A `feeds` link's field within its view, and the input name the app sees. */
      readonly path?: string;
      readonly name?: string;
      /** Stamped by the server. */
      readonly by?: string | null;
      readonly byAgent?: string | null;
      readonly at?: string | null;
    }
  /**
   * A semantic link's type, or a `feeds` link's view, field and input name.
   * Absent leaves a field alone; an empty `path` or `name` clears it. Never
   * moves a link between semantic and data types: that would grant or revoke
   * access.
   */
  | {
      readonly type: 'link.set';
      readonly linkId: LinkId;
      readonly linkType: LinkType;
      readonly view?: string;
      readonly path?: string;
      readonly name?: string;
    }
  | { readonly type: 'link.delete'; readonly linkId: LinkId }
  /** The board's centerpiece, or none (canvas/centerpiece). Absolute state. */
  | { readonly type: 'board.centerpiece'; readonly target: Centerpiece | null }
  /**
   * One run of an app ends in its next output version (canvas/apps). The
   * server numbers it and stamps its inputs' content revisions.
   */
  | {
      readonly type: 'app.output';
      readonly itemId: ItemId;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly text?: string;
      readonly status: 'ok' | 'error';
      readonly error?: string;
      /**
       * What the server stored (version, input revisions, the app's content
       * revision), written by it after applying. Absent on a client's own
       * optimistic copy, which works the same out locally.
       */
      readonly record?: AppOutputRecord;
      /** Stamped by the server. */
      readonly by?: string | null;
      readonly byAgent?: string | null;
      readonly at?: string | null;
    }
  /**
   * An app's title, source, literals or run mode (canvas/app-inspector).
   * Absent fields are left alone; `literals` is the whole set. A new source
   * or new literals make the app stale; neither changes its outputs.
   */
  | {
      readonly type: 'app.set';
      readonly itemId: ItemId;
      readonly title?: string;
      readonly html?: string;
      readonly literals?: Readonly<Record<string, unknown>>;
      readonly run?: AppRunMode;
      /** An MCP app's view, moved to a newer fetched resource (an update, applied). */
      readonly mcpSha256?: string;
    }
  /**
   * The picture an output version leaves on the app's card: a snapshot of its
   * view (canvas/apps). For the latest version only; never on an undo stack.
   */
  | {
      readonly type: 'app.card';
      readonly itemId: ItemId;
      readonly version: number;
      readonly html: string;
    }
  /** Undo of an output: an earlier version's values, committed as the next version. */
  | {
      readonly type: 'app.output.revert';
      readonly itemId: ItemId;
      readonly toVersion: number;
      /** As on `app.output`. */
      readonly record?: AppOutputRecord;
      /**
       * Client-side only: the output being restored, for applying an undo
       * locally before the server answers. The server goes by `toVersion`.
       */
      readonly was?: AppOutput;
      readonly by?: string | null;
      readonly byAgent?: string | null;
      readonly at?: string | null;
    };

/** A stored output plus the app's content revision after it. */
export type AppOutputRecord = AppOutput & { readonly contentRev: number };

export type CanvasOperationType = CanvasOperationBody['type'];

export interface CanvasOperation {
  readonly operationId: OperationId;
  readonly canvasId: CanvasId;
  readonly actorId: ActorId;
  readonly body: CanvasOperationBody;
  /**
   * Document revision the client believed it was editing. The server uses it to
   * detect a client that has fallen behind; it is not a lock and does not by
   * itself reject the operation. See REALTIME_COLLABORATION.md.
   */
  readonly baseRevision: number;
}
