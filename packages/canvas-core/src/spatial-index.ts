/**
 * Spatial index over item bounds.
 *
 * Thin wrapper over RBush. The wrapper exists so the rest of the model speaks in
 * {@link Rect} and {@link ItemId} rather than RBush's mutable `{minX,...,id}`
 * entries, and so the tree can be swapped if 100k-item profiling ever demands it.
 *
 * Rotated items are indexed by their axis-aligned bounds, so queries are
 * CONSERVATIVE — they may return items that do not truly intersect. Refine with
 * `transformIntersectsRect` when exactness matters.
 */

import RBush from 'rbush';
import { type Rect, rect } from './geometry';
import type { ItemId } from './ids';

interface Entry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: ItemId;
}

export class SpatialIndex {
  #tree = new RBush<Entry>();
  #entries = new Map<ItemId, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  insert(id: ItemId, bounds: Rect): void {
    this.remove(id);
    const entry: Entry = { ...bounds, id };
    this.#entries.set(id, entry);
    this.#tree.insert(entry);
  }

  /** Re-index after a transform change. Remove + insert; RBush has no in-place move. */
  update(id: ItemId, bounds: Rect): void {
    this.insert(id, bounds);
  }

  remove(id: ItemId): void {
    const existing = this.#entries.get(id);
    if (!existing) return;
    this.#tree.remove(existing);
    this.#entries.delete(id);
  }

  clear(): void {
    this.#tree.clear();
    this.#entries.clear();
  }

  /** Bulk-load. Far cheaper than N inserts when populating a freshly loaded board. */
  load(items: Iterable<readonly [ItemId, Rect]>): void {
    const entries: Entry[] = [];
    for (const [id, bounds] of items) {
      const entry: Entry = { ...bounds, id };
      this.#entries.set(id, entry);
      entries.push(entry);
    }
    this.#tree.load(entries);
  }

  /** Ids whose bounds intersect `area`. Order is unspecified. */
  search(area: Rect): ItemId[] {
    return this.#tree.search(area).map((e) => e.id);
  }

  collides(area: Rect): boolean {
    return this.#tree.collides(area);
  }

  boundsOf(id: ItemId): Rect | undefined {
    return this.#entries.get(id);
  }

  /**
   * Everything in the index, as one rect. `undefined` when it is empty.
   *
   * O(1): RBush maintains the root node's envelope as the tree is built, so this
   * reads a value that already exists. That is the whole reason it is here —
   * framing a 100,000-item board must not iterate 100,000 transforms on a
   * keypress.
   */
  bounds(): Rect | undefined {
    if (this.#entries.size === 0) return undefined;
    const root = this.#tree.toJSON() as Rect;
    return rect(root.minX, root.minY, root.maxX, root.maxY);
  }
}
