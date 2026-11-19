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
  CanvasItemContent,
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
      readonly at?: string | null;
    }
  | { readonly type: 'task.remove'; readonly itemId: ItemId; readonly taskId: string }
  | {
      readonly type: 'link.add';
      readonly linkId: LinkId;
      readonly from: Anchor;
      readonly to: Anchor;
      readonly linkType: LinkType;
      /** Stamped by the server. */
      readonly by?: string | null;
      readonly byAgent?: string | null;
      readonly at?: string | null;
    }
  | { readonly type: 'link.set'; readonly linkId: LinkId; readonly linkType: LinkType }
  | { readonly type: 'link.delete'; readonly linkId: LinkId };

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
