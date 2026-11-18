/**
 * The loaded canvas.
 *
 * `CanvasDocument` owns the authoritative in-memory model of one board: its
 * items, its groups, its spatial index and the revision it has caught up to.
 * It is a plain mutable object, not React state — see STATE_OWNERSHIP in
 * docs/architecture/CANVAS_CORE.md. A board of 100k items lives here and nowhere
 * else; React only ever learns about the small subset currently on screen.
 *
 * The only way in is {@link applyOperation}.
 */

import { type Rect, transformBounds, unionRects } from './geometry';
import type { CanvasId, GroupId, ItemId } from './ids';
import { type CanvasGroup, type CanvasItem, DEFAULT_APPEARANCE } from './model';
import type { CanvasOperationBody } from './operations';
import { SpatialIndex } from './spatial-index';

/**
 * Where an operation came from.
 *
 * `remote` means it arrived already committed from another client, so it must
 * not be sent back to the server and must not enter this client's undo history:
 * undo is for what you did, not for what you watched someone else do.
 */
export type OperationOrigin = 'local' | 'remote';

export class CanvasDocument {
  readonly canvasId: CanvasId;
  readonly index = new SpatialIndex();

  #items = new Map<ItemId, CanvasItem>();
  #groups = new Map<GroupId, CanvasGroup>();
  #revision = 0;
  #applied: ((body: CanvasOperationBody, origin: OperationOrigin) => void) | undefined;

  constructor(canvasId: CanvasId) {
    this.canvasId = canvasId;
  }

  /** Last server revision this document reflects. */
  get revision(): number {
    return this.#revision;
  }

  get itemCount(): number {
    return this.#items.size;
  }

  get groupCount(): number {
    return this.#groups.size;
  }

  items(): IterableIterator<CanvasItem> {
    return this.#items.values();
  }

  item(id: ItemId): CanvasItem | undefined {
    return this.#items.get(id);
  }

  group(id: GroupId): CanvasGroup | undefined {
    return this.#groups.get(id);
  }

  groups(): IterableIterator<CanvasGroup> {
    return this.#groups.values();
  }

  /**
   * Replace the whole document from a server snapshot.
   *
   * This is the reconnect path: cheaper and far less error-prone than replaying
   * a long operation log, and correct by construction. See ADR-0011.
   */
  loadSnapshot(
    items: readonly CanvasItem[],
    groups: readonly CanvasGroup[],
    revision: number,
  ): void {
    this.#items = new Map(items.map((i) => [i.id, i]));
    this.#groups = new Map(groups.map((g) => [g.id, g]));
    this.index.clear();
    this.index.load(items.map((i) => [i.id, transformBounds(i.transform)] as const));
    this.#revision = revision;
  }

  /** Bounds of a group, or `undefined` if it is empty or unknown. */
  groupBounds(groupId: GroupId): Rect | undefined {
    const group = this.#groups.get(groupId);
    if (!group) return undefined;
    const rects: Rect[] = [];
    for (const id of group.memberIds) {
      const bounds = this.index.boundsOf(id);
      if (bounds) rects.push(bounds);
    }
    return unionRects(rects);
  }

  setRevision(revision: number): void {
    this.#revision = revision;
  }

  /**
   * Observe every operation that actually changed this document.
   *
   * This exists so persistence has ONE place to watch. Invariant 9 already
   * promises that every durable change arrives through `apply` — local edits,
   * undo, redo, and an upload resolving a placeholder all do — so a listener
   * here cannot be bypassed by a caller who forgot, which a `sync.send()` beside
   * each call site can.
   *
   * Set it AFTER the document is populated, never before: `buildBoard` fills a
   * benchmark board by applying up to 100,000 `item.create` operations, and a
   * listener attached first would hear every one of them.
   *
   * No-ops are not reported. The listener fires only when `apply` returns an
   * inverse, which is exactly when something changed.
   *
   * The origin says where the operation came from. Persistence uses it to ignore
   * what it must not echo: an operation that arrived from another client is
   * already durable, and sending it back would be this client claiming someone
   * else's edit as its own.
   */
  onApplied(
    listener: ((body: CanvasOperationBody, origin: OperationOrigin) => void) | undefined,
  ): void {
    this.#applied = listener;
  }

  // --- mutation -----------------------------------------------------------

  #put(item: CanvasItem): void {
    this.#items.set(item.id, item);
    this.index.update(item.id, transformBounds(item.transform));
  }

  #drop(id: ItemId): void {
    this.#items.delete(id);
    this.index.remove(id);
  }

  /**
   * Apply one operation.
   *
   * Returns the operation that would undo it, or `undefined` when the operation
   * was a no-op (unknown target, already-applied delete). An unknown target is
   * not an error: with optimistic local application and out-of-order delivery it
   * is a normal, benign race.
   *
   * Remote operations take this same path — invariant 9 has no exception for the
   * network — and differ only in the origin they carry.
   */
  apply(
    body: CanvasOperationBody,
    origin: OperationOrigin = 'local',
  ): CanvasOperationBody | undefined {
    const inverse = this.#applyBody(body);
    if (inverse) this.#applied?.(body, origin);
    return inverse;
  }

  #applyBody(body: CanvasOperationBody): CanvasOperationBody | undefined {
    switch (body.type) {
      case 'item.create': {
        if (this.#items.has(body.itemId)) return undefined;
        this.#put({
          id: body.itemId,
          transform: body.transform,
          z: body.z,
          content: body.content,
          appearance: body.appearance ?? DEFAULT_APPEARANCE,
          ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
        });
        return { type: 'item.delete', itemId: body.itemId };
      }

      case 'item.delete': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#drop(body.itemId);
        return {
          type: 'item.create',
          itemId: existing.id,
          transform: existing.transform,
          z: existing.z,
          content: existing.content,
          // The field this literal is most likely to be missing, and the one
          // whose absence is silent: without it, delete-then-undo is an
          // appearance reset that gets reported as "undo is broken" weeks later.
          appearance: existing.appearance,
          ...(existing.groupId !== undefined ? { groupId: existing.groupId } : {}),
        };
      }

      case 'item.transform': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#put({ ...existing, transform: body.transform });
        return { type: 'item.transform', itemId: body.itemId, transform: existing.transform };
      }

      case 'item.content': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#put({ ...existing, content: body.content });
        return { type: 'item.content', itemId: body.itemId, content: existing.content };
      }

      case 'item.z': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#put({ ...existing, z: body.z });
        return { type: 'item.z', itemId: body.itemId, z: existing.z };
      }

      case 'item.appearance': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        // Not `#put`: appearance never changes bounds, so the index has nothing
        // to hear. Keeping it out is the structural reason opacity and flip are
        // one operation rather than two.
        this.#items.set(body.itemId, { ...existing, appearance: body.appearance });
        return {
          type: 'item.appearance',
          itemId: body.itemId,
          appearance: existing.appearance,
        };
      }

      case 'group.create': {
        if (this.#groups.has(body.groupId)) return undefined;
        this.#groups.set(body.groupId, {
          id: body.groupId,
          memberIds: [...body.memberIds],
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.frame !== undefined ? { frame: body.frame } : {}),
        });
        for (const id of body.memberIds) {
          const item = this.#items.get(id);
          if (item) this.#items.set(id, { ...item, groupId: body.groupId });
        }
        return { type: 'group.delete', groupId: body.groupId };
      }

      case 'group.delete': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.delete(body.groupId);
        for (const id of existing.memberIds) {
          const item = this.#items.get(id);
          if (item?.groupId === body.groupId) {
            const { groupId: _dropped, ...rest } = item;
            this.#items.set(id, rest);
          }
        }
        return {
          type: 'group.create',
          groupId: existing.id,
          memberIds: existing.memberIds,
          ...(existing.label !== undefined ? { label: existing.label } : {}),
          ...(existing.frame !== undefined ? { frame: existing.frame } : {}),
        };
      }

      case 'group.members': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        const previous = existing.memberIds;
        this.#groups.set(body.groupId, { ...existing, memberIds: [...body.memberIds] });
        for (const id of previous) {
          const item = this.#items.get(id);
          if (item?.groupId === body.groupId) {
            const { groupId: _dropped, ...rest } = item;
            this.#items.set(id, rest);
          }
        }
        for (const id of body.memberIds) {
          const item = this.#items.get(id);
          if (item) this.#items.set(id, { ...item, groupId: body.groupId });
        }
        return { type: 'group.members', groupId: body.groupId, memberIds: previous };
      }

      case 'group.label': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.set(body.groupId, { ...existing, label: body.label });
        // A group that had no label inverts to the empty string rather than to
        // an absent one: `label` carries absolute state and an inverse that
        // omitted it would be a rename to nothing in particular.
        return { type: 'group.label', groupId: body.groupId, label: existing.label ?? '' };
      }

      case 'group.frame': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.set(body.groupId, { ...existing, frame: body.frame });
        // The same absolute-state rule as `group.label`: a group that had no
        // flag inverts to `false`, not to a field nobody set.
        return { type: 'group.frame', groupId: body.groupId, frame: existing.frame ?? false };
      }
    }
  }
}
