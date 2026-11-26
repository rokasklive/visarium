import { describe, expect, it } from 'vitest';
import { appStates } from './apps';
import { CanvasDocument } from './document';
import { asCanvasId, asItemId, asLinkId } from './ids';
import type { CanvasItem, CanvasItemContent } from './model';
import { DEFAULT_APPEARANCE, FULL_CROP } from './model';

const N3 = asItemId('n3');
const A1 = asItemId('a1');
const A2 = asItemId('a2');
const box = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };

const item = (id: typeof N3, content: CanvasItemContent, contentRev: number): CanvasItem => ({
  id,
  transform: box,
  z: 0,
  content,
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
  revision: 0,
  contentRev,
});
const app = (
  id: typeof A1,
  rev: number,
  inputRevs?: Record<string, number>,
  status: 'ok' | 'error' = 'ok',
) =>
  item(
    id,
    {
      kind: 'app',
      title: id,
      html: '<p>x</p>',
      ...(inputRevs
        ? {
            output: {
              version: 1,
              outputs: { v: 1 },
              inputRevs,
              status,
              error: status === 'error' ? 'boom' : null,
            },
          }
        : {}),
    },
    rev,
  );

/** n3 feeds a1, a1 feeds a2: the same board as the server's tests. */
function board(items: CanvasItem[]) {
  const d = new CanvasDocument(asCanvasId('b'));
  const feed = (id: string, from: typeof N3, to: typeof N3) => ({
    id: asLinkId(id),
    from: { itemId: from },
    to: { itemId: to },
    linkType: 'feeds' as const,
    view: 'text',
  });
  d.loadSnapshot(items, [], 1, [feed('l1', N3, A1), feed('l2', A1, A2)]);
  return d;
}

describe('app states (kept equal to server/src/apps.rs)', () => {
  it('an edit makes an app stale and its dependents upstream stale', () => {
    const s = appStates(
      board([
        item(N3, { kind: 'note', source: 'x' }, 9),
        app(A1, 4, { n3: 7 }),
        app(A2, 2, { a1: 4 }),
      ]),
    );
    expect(s.get(A1)).toEqual({ state: 'stale', moved: [{ itemId: 'n3', was: 7, now: 9 }] });
    expect(s.get(A2)).toEqual({ state: 'upstream stale', from: ['a1'] });
  });

  it('matching inputs are fresh, and a missing output never ran', () => {
    const s = appStates(
      board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4, { n3: 7 }), app(A2, 2)]),
    );
    expect(s.get(A1)).toEqual({ state: 'fresh' });
    expect(s.get(A2)).toEqual({ state: 'never run' });
  });

  it('errors show on the app and downstream', () => {
    const s = appStates(
      board([
        item(N3, { kind: 'note', source: 'x' }, 7),
        app(A1, 2, { n3: 7 }, 'error'),
        app(A2, 2, { a1: 2 }),
      ]),
    );
    expect(s.get(A1)).toEqual({ state: 'error', error: 'boom' });
    expect(s.get(A2)).toEqual({ state: 'upstream error', from: ['a1'] });
  });

  it('a run in the document stamps its inputs, so it is fresh at once', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4), app(A2, 2)]);
    d.apply({ type: 'app.output', itemId: A1, outputs: { premium: 1240 }, status: 'ok' });
    expect(appStates(d).get(A1)).toEqual({ state: 'fresh' });
    expect(appStates(d).get(A2)).toEqual({ state: 'never run' });
    d.apply({ type: 'item.source', itemId: N3, source: 'y' });
    expect(appStates(d).get(A1)).toMatchObject({ state: 'stale' });
    // Moving the note is not editing it.
    const d2 = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4)]);
    d2.apply({ type: 'app.output', itemId: A1, outputs: {}, status: 'ok' });
    d2.apply({ type: 'item.transform', itemId: N3, transform: { ...box, x: 300 } });
    expect(appStates(d2).get(A1)).toEqual({ state: 'fresh' });
  });

  it('undo of a run commits the last values again', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4, { n3: 7 })]);
    const undo = d.apply({ type: 'app.output', itemId: A1, outputs: { v: 2 }, status: 'ok' });
    expect(undo).toMatchObject({ type: 'app.output.revert', toVersion: 1 });
    d.apply(undo as never);
    const out = d.item(A1)?.content;
    expect(out?.kind === 'app' && out.output).toMatchObject({ version: 3, outputs: { v: 1 } });
  });

  it('a record from the server is taken as it is', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4)]);
    d.apply({
      type: 'app.output',
      itemId: A1,
      outputs: { v: 1 },
      status: 'ok',
      record: { version: 5, outputs: { v: 1 }, inputRevs: { n3: 7 }, status: 'ok', contentRev: 11 },
    });
    expect(d.item(A1)?.contentRev).toBe(11);
    const c = d.item(A1)?.content;
    expect(c?.kind === 'app' && c.output?.version).toBe(5);
  });
});
