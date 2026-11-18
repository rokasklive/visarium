/**
 * Undo and redo.
 *
 * `CanvasDocument.apply` already returns the operation that would undo what it
 * just did, so history is two stacks of those bodies and nothing else. No
 * command objects, no second mutation path — undo goes back in through
 * `apply`, exactly like every other change (ADR-0004).
 *
 * An entry is a LIST of bodies, because one gesture is often several
 * operations: dragging five selected items is five `item.transform` ops and one
 * Ctrl+Z. Inverses within an entry are stored in reverse order, so undoing
 * unwinds them in the order that makes overlapping edits come out right.
 */

import type { CanvasDocument } from './document';
import type { CanvasOperationBody } from './operations';

export class CanvasHistory {
  readonly #doc: CanvasDocument;
  #undo: CanvasOperationBody[][] = [];
  #redo: CanvasOperationBody[][] = [];

  constructor(doc: CanvasDocument) {
    this.#doc = doc;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Depth of the undo stack. Gestures, not operations. */
  get depth(): number {
    return this.#undo.length;
  }

  /**
   * Apply one gesture's worth of operations as a single undo step.
   *
   * Returns `false` when nothing changed — every body was a no-op, so no undo
   * slot is taken and the redo stack survives.
   */
  apply(...bodies: CanvasOperationBody[]): boolean {
    const inverses = this.#run(bodies);
    if (inverses.length === 0) return false;
    this.#undo.push(inverses);
    this.#redo.length = 0;
    return true;
  }

  undo(): boolean {
    const entry = this.#undo.pop();
    if (!entry) return false;
    const inverses = this.#run(entry);
    if (inverses.length > 0) this.#redo.push(inverses);
    return true;
  }

  redo(): boolean {
    const entry = this.#redo.pop();
    if (!entry) return false;
    const inverses = this.#run(entry);
    if (inverses.length > 0) this.#undo.push(inverses);
    return true;
  }

  /** Forget everything. The reconnect path: a snapshot invalidates local history. */
  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }

  /** Apply bodies in order, collecting their inverses in reverse. */
  #run(bodies: readonly CanvasOperationBody[]): CanvasOperationBody[] {
    const inverses: CanvasOperationBody[] = [];
    for (const body of bodies) {
      const inverse = this.#doc.apply(body);
      if (inverse) inverses.unshift(inverse);
    }
    return inverses;
  }
}
