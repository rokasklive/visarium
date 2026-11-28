/**
 * Where an app's outputs stand (canvas/apps, ADR-0034). Never stored: derived
 * from the board as it is, the same way `server/src/apps.rs::status` derives
 * it for agents. Both are tested on the same cases; keep them in step.
 */

import type { CanvasDocument } from './document';
import type { ItemId } from './ids';

/** The stamps of an app's own source and input setup, beside its inputs' item ids. */
export const OWN_SOURCE = '#source';
export const OWN_SETUP = '#setup';

/**
 * An input that moved since the output: `was` absent if connected since, `now`
 * if disconnected. `itemId` is {@link OWN_SOURCE} or {@link OWN_SETUP} when the
 * app's own source or input setup changed.
 */
export interface Moved {
  readonly itemId: string;
  readonly was?: number;
  readonly now?: number;
}

export type AppState =
  | { readonly state: 'never run' }
  | { readonly state: 'fresh' }
  | { readonly state: 'stale'; readonly moved: readonly Moved[] }
  | { readonly state: 'error'; readonly error: string }
  | { readonly state: 'upstream stale'; readonly from: readonly string[] }
  | { readonly state: 'upstream error'; readonly from: readonly string[] };

const behind = (s: AppState) =>
  s.state === 'never run' || s.state === 'stale' || s.state === 'upstream stale';
const failed = (s: AppState) => s.state === 'error' || s.state === 'upstream error';

/** Every app's state on the board. */
export function appStates(doc: CanvasDocument): Map<ItemId, AppState> {
  const feeds = [...doc.links()].filter((l) => l.linkType === 'feeds');
  const apps = new Set([...doc.items()].filter((i) => i.content.kind === 'app').map((i) => i.id));
  const done = new Map<ItemId, AppState>();
  const visiting = new Set<ItemId>();

  const stateOf = (id: ItemId): AppState => {
    const known = done.get(id);
    if (known) return known;
    // Links refuse cycles; a corrupted board must still not recurse forever.
    if (visiting.has(id)) return { state: 'fresh' };
    visiting.add(id);
    const item = doc.item(id);
    const output = item?.content.kind === 'app' ? item.content.output : undefined;
    const sources = feeds.filter((l) => l.to.itemId === id).map((l) => l.from.itemId as string);
    let state: AppState;
    if (!output) {
      state = { state: 'never run' };
    } else {
      const moved: Moved[] = [];
      for (const s of sources) {
        const now = doc.item(s as ItemId)?.contentRev;
        const was = output.inputRevs[s];
        if (was !== now)
          moved.push({
            itemId: s,
            ...(was !== undefined ? { was } : {}),
            ...(now !== undefined ? { now } : {}),
          });
      }
      for (const k of Object.keys(output.inputRevs).sort())
        if (!k.startsWith('#') && !sources.includes(k))
          moved.push({ itemId: k, was: output.inputRevs[k] as number });
      // The app's own source and setup. An output stamped before they were
      // counted has neither, and matches.
      const c = item?.content.kind === 'app' ? item.content : undefined;
      for (const [k, now] of [
        [OWN_SOURCE, c?.sourceRev ?? 0],
        [OWN_SETUP, c?.setupRev ?? 0],
      ] as const) {
        const was = output.inputRevs[k];
        if (was !== undefined && was !== now) moved.push({ itemId: k, was, now });
      }
      if (moved.length) state = { state: 'stale', moved };
      else if (output.status === 'error') state = { state: 'error', error: output.error ?? '' };
      else {
        const up = sources
          .filter((s) => apps.has(s as ItemId))
          .map((s) => [s, stateOf(s as ItemId)] as const);
        const errs = up.filter(([, st]) => failed(st)).map(([s]) => s);
        const late = up.filter(([, st]) => !failed(st) && behind(st)).map(([s]) => s);
        state = errs.length
          ? { state: 'upstream error', from: errs }
          : late.length
            ? { state: 'upstream stale', from: late }
            : { state: 'fresh' };
      }
    }
    visiting.delete(id);
    done.set(id, state);
    return state;
  };

  for (const id of apps) stateOf(id);
  return done;
}
