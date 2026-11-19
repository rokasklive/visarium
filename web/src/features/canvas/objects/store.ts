/**
 * Layouts of the object items on one board, and who should write their height.
 *
 * A layout is keyed by what decides it, the item's width and content, never by
 * revision: a move or a z change re-uses it, a new word or a resize does not.
 *
 * Height (spec: notes, diagrams; design D7). An object's height follows its
 * content with its top edge fixed, and exactly ONE client writes that height:
 * the one whose own change made it different. Every other client draws the
 * height it derives itself and writes nothing, so a source change seen by
 * three people is one transform on the wire, not three.
 *
 * The exception is an item nobody here authored but that has collision on —
 * in practice, one an agent made. Its stored height is the server's estimate,
 * and the board can only push neighbours aside (canvas/collision) once it
 * learns the drawn height, so a client that draws it differently writes it.
 * The write is absolute, so two clients doing it at once agree.
 */

import type {
  CanvasDocument,
  CanvasItem,
  CanvasOperationBody,
  ItemId,
  OperationOrigin,
  Transform,
} from '@visarium/canvas-core';
import { type Layout, layoutItem, layoutSource, SourceError } from './layout';

export function isObject(item: CanvasItem): boolean {
  const k = item.content.kind;
  return k === 'note' || k === 'diagram' || k === 'checklist';
}

/** What decides an object's layout. Identical keys mean an identical drawing. */
export function layoutKey(item: CanvasItem): string {
  const c = item.content;
  const w = Math.round(item.transform.width * 100) / 100;
  switch (c.kind) {
    case 'note':
      return `${w}|n|${c.source}`;
    case 'diagram':
      return `${w}|d|${c.lang}|${c.source}`;
    case 'checklist':
      return `${w}|c|${JSON.stringify([c.title, c.tasks.map((t) => [t.id, t.text, t.state])])}`;
    default:
      return `${w}|${c.kind}`;
  }
}

export interface ObjectView {
  readonly layout: Layout;
  readonly key: string;
  /** The source no longer parses; this is the last drawing that did. */
  readonly stale: boolean;
  readonly error?: string;
}

interface Entry {
  key: string;
  view?: ObjectView;
  /** The last layout that rendered, kept for when the source stops parsing. */
  good?: { layout: Layout; key: string };
  inflight?: string;
}

const RESIZED_EPSILON = 0.5;

export class ObjectLayouts {
  readonly #entries = new Map<ItemId, Entry>();
  /** Items whose next layout this client must write the height of. */
  readonly #authored = new Set<ItemId>();
  readonly #doc: CanvasDocument;
  readonly #onReady: () => void;
  readonly #onElements: (itemId: ItemId, key: string, layout: Layout) => void;

  /**
   * @param onElements a diagram laid out cleanly: where its named elements
   *   are, so the server can place things next to them (agents/placement).
   */
  constructor(
    doc: CanvasDocument,
    onReady: () => void,
    onElements: (itemId: ItemId, key: string, layout: Layout) => void = () => {},
  ) {
    this.#doc = doc;
    this.#onReady = onReady;
    this.#onElements = onElements;
  }

  /** The drawing to show now: the current one, or the last good one while a newer is coming. */
  view(item: CanvasItem): ObjectView | undefined {
    return this.#entries.get(item.id)?.view;
  }

  /** Lay the item out unless that layout is already here or coming. */
  request(item: CanvasItem): void {
    if (!isObject(item)) return;
    const key = layoutKey(item);
    const entry = this.#entries.get(item.id) ?? { key };
    this.#entries.set(item.id, entry);
    if (entry.view?.key === key || entry.inflight === key) return;
    entry.inflight = key;
    entry.key = key;
    void this.#lay(item, entry, key);
  }

  async #lay(item: CanvasItem, entry: Entry, key: string): Promise<void> {
    let view: ObjectView;
    try {
      const layout = await layoutItem(item);
      entry.good = { layout, key };
      view = { layout, key, stale: false };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (!(e instanceof SourceError)) console.warn('object layout failed', item.id, e);
      // Keep the last good drawing, marked; with none, show the source itself.
      view = entry.good
        ? { layout: entry.good.layout, key, stale: true, error }
        : {
            layout: await layoutSource(
              item.content.kind === 'diagram' ? item.content.source : '',
              item.transform.width,
            ),
            key,
            stale: true,
            error,
          };
    }
    if (entry.inflight !== key) return; // superseded while laying out
    delete entry.inflight;
    entry.view = view;
    this.#writeHeight(item.id, view);
    if (!view.stale && item.content.kind === 'diagram' && view.layout.elements.size > 0)
      this.#onElements(item.id, key, view.layout);
    this.#onReady();
  }

  /**
   * Every applied operation passes here. A LOCAL change to what an object shows,
   * or to its width, makes this client the one that writes its next height.
   */
  noteApplied = (body: CanvasOperationBody, origin: OperationOrigin): void => {
    if (origin !== 'local') return;
    switch (body.type) {
      case 'item.create':
      case 'item.source':
      case 'checklist.title':
      case 'task.add':
      case 'task.set':
      case 'task.remove':
        this.#authored.add(body.itemId);
        return;
      case 'item.transform': {
        const view = this.#entries.get(body.itemId)?.view;
        if (view && Math.abs(view.layout.width - body.transform.width) > RESIZED_EPSILON) {
          this.#authored.add(body.itemId);
        }
        return;
      }
      default:
        return;
    }
  };

  #writeHeight(itemId: ItemId, view: ObjectView): void {
    const item = this.#doc.item(itemId);
    if (!item) return;
    if (!this.#authored.has(itemId) && !this.#collides(item)) return;
    if (layoutKey(item) !== view.key) return; // changed again since; wait for that layout
    this.#authored.delete(itemId);
    const next = topAnchored(item.transform, drawnHeight(item, view.layout));
    if (Math.abs(next.height - item.transform.height) <= RESIZED_EPSILON) return;
    // Not through history: the height is a consequence of the change, and the
    // undo of that change re-derives it the same way.
    this.#doc.apply({ type: 'item.transform', itemId, transform: next });
  }

  #collides(item: CanvasItem): boolean {
    const group = item.groupId !== undefined ? this.#doc.group(item.groupId) : undefined;
    return (group ? group.collides : item.collides) ?? false;
  }

  /** For the dev hook and its tests. */
  debug(itemId: ItemId) {
    const view = this.#entries.get(itemId)?.view;
    if (!view) return undefined;
    return {
      width: view.layout.width,
      height: view.layout.height,
      stale: view.stale,
      error: view.error,
      hits: view.layout.hits,
      elements: Object.fromEntries(view.layout.elements),
    };
  }
}

/** The item's height when its layout is drawn at the item's width. */
export function drawnHeight(item: CanvasItem, layout: Layout): number {
  return (item.transform.width * layout.height) / layout.width;
}

/**
 * The transform with a new height and the SAME top edge. The centre moves half
 * the change along the item's own (rotated) vertical axis.
 */
export function topAnchored(t: Transform, height: number): Transform {
  const half = (height - t.height) / 2;
  return {
    ...t,
    height,
    x: t.x - Math.sin(t.rotation) * half,
    y: t.y + Math.cos(t.rotation) * half,
  };
}
