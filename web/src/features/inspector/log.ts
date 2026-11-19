/**
 * The operations a board sent and received, for a dev build's inspector
 * (spec: canvas/inspector). Only constructed when DEVTOOLS is true; in a
 * production build nothing references this module and it is not emitted.
 */

import type { CanvasOperationBody, OperationOrigin } from '@visarium/canvas-core';
import type { PostOutcome } from '../canvas/board-sync';

export interface LogEntry {
  readonly seq: number;
  readonly dir: 'sent' | 'received';
  readonly at: Date;
  readonly body: CanvasOperationBody;
  /** `pending` until the server answers; `ok` or `rejected` after; `received` for others' operations. */
  outcome: 'pending' | 'ok' | 'rejected' | 'received';
  message?: string;
}

const LIMIT = 500;

export class OpLog {
  #entries: LogEntry[] = [];
  #byBody = new WeakMap<CanvasOperationBody, LogEntry>();
  #seq = 0;
  #listeners = new Set<() => void>();

  /** Newest first. A new array whenever anything changes, for `useSyncExternalStore`. */
  entries = (): readonly LogEntry[] => this.#entries;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  record(body: CanvasOperationBody, origin: OperationOrigin): void {
    const entry: LogEntry = {
      seq: ++this.#seq,
      dir: origin === 'local' ? 'sent' : 'received',
      at: new Date(),
      body,
      outcome: origin === 'local' ? 'pending' : 'received',
    };
    this.#byBody.set(body, entry);
    this.#entries = [entry, ...this.#entries].slice(0, LIMIT);
    this.#emit();
  }

  /** What the server made of a batch this client posted. */
  posted(batch: readonly CanvasOperationBody[], outcome: PostOutcome): void {
    for (const body of batch) {
      const entry = this.#byBody.get(body);
      if (!entry) continue;
      entry.outcome = outcome.ok ? 'ok' : 'rejected';
      if (!outcome.ok) entry.message = `${outcome.status}: ${outcome.message}`;
    }
    this.#entries = [...this.#entries];
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}
