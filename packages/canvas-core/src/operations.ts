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
import type { ActorId, CanvasId, GroupId, ItemId, OperationId } from './ids';
import type { Appearance, CanvasItemContent } from './model';

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
    }
  | { readonly type: 'item.delete'; readonly itemId: ItemId }
  | {
      readonly type: 'item.transform';
      readonly itemId: ItemId;
      readonly transform: Transform;
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
  | { readonly type: 'group.frame'; readonly groupId: GroupId; readonly frame: boolean };

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
