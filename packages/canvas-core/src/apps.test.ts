import { describe, expect, it } from 'vitest';
import { appStates } from './apps';
import { CanvasDocument } from './document';
import { asCanvasId, asItemId, asLinkId } from './ids';
import type { CanvasItem, CanvasItemContent } from './model';
import { contentFrom, DEFAULT_APPEARANCE, FULL_CROP } from './model';

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

  it('a source edit or new literals make an app stale, and undo restores both', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4), app(A2, 2)]);
    d.apply({ type: 'app.output', itemId: A1, outputs: { v: 1 }, status: 'ok' });
    expect(appStates(d).get(A1)).toEqual({ state: 'fresh' });

    const undoSource = d.apply({ type: 'app.set', itemId: A1, html: '<p>y</p>' });
    expect(appStates(d).get(A1)).toEqual({
      state: 'stale',
      moved: [{ itemId: '#source', was: 0, now: 1 }],
    });
    // The source changed, the outputs did not: nothing downstream moves.
    expect(d.item(A1)?.contentRev).toBe(5);
    expect(undoSource).toEqual({ type: 'app.set', itemId: A1, html: '<p>x</p>' });

    const undoLiterals = d.apply({ type: 'app.set', itemId: A1, literals: { rate: 0.05 } });
    expect(appStates(d).get(A1)).toMatchObject({
      state: 'stale',
      moved: [
        { itemId: '#source', was: 0, now: 1 },
        { itemId: '#setup', was: 0, now: 1 },
      ],
    });
    expect(undoLiterals).toEqual({ type: 'app.set', itemId: A1, literals: {} });
    d.apply(undoLiterals as never);
    const c = d.item(A1)?.content;
    expect(c?.kind === 'app' && c.literals).toBeUndefined();
  });

  it('changing what a feeds link carries makes its app stale; its type does not', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4), app(A2, 2)]);
    d.apply({ type: 'app.output', itemId: A1, outputs: {}, status: 'ok' });
    const undo = d.apply({
      type: 'link.set',
      linkId: asLinkId('l1'),
      linkType: 'feeds',
      path: 'age',
      name: 'age',
    });
    expect(d.link(asLinkId('l1'))).toMatchObject({ path: 'age', name: 'age', view: 'text' });
    expect(appStates(d).get(A1)).toEqual({
      state: 'stale',
      moved: [{ itemId: '#setup', was: 0, now: 1 }],
    });
    expect(undo).toEqual({
      type: 'link.set',
      linkId: asLinkId('l1'),
      linkType: 'feeds',
      path: '',
      name: '',
    });
    d.apply(undo as never);
    const l = d.link(asLinkId('l1'));
    expect(l?.path).toBeUndefined();
    expect(l?.name).toBeUndefined();
  });

  it('an output stamped before source and setup were counted still matches', () => {
    const s = appStates(
      board([
        item(N3, { kind: 'note', source: 'x' }, 7),
        {
          ...app(A1, 4, { n3: 7 }),
          content: { ...app(A1, 4, { n3: 7 }).content, sourceRev: 3 } as CanvasItemContent,
        },
      ]),
    );
    expect(s.get(A1)).toEqual({ state: 'fresh' });
  });

  it('a card attaches to the latest version only, without a revision', () => {
    const d = board([item(N3, { kind: 'note', source: 'x' }, 7), app(A1, 4, { n3: 7 })]);
    const rev = d.item(A1)?.revision;
    expect(
      d.apply({ type: 'app.card', itemId: A1, version: 2, html: '<p>old</p>' }),
    ).toBeUndefined();
    let c = d.item(A1)?.content;
    expect(c?.kind === 'app' && c.output?.card).toBeFalsy();
    expect(d.apply({ type: 'app.card', itemId: A1, version: 1, html: '<p>pic</p>' })).toEqual({
      type: 'app.card',
      itemId: A1,
      version: 1,
      html: '',
    });
    c = d.item(A1)?.content;
    expect(c?.kind === 'app' && c.output?.card).toBe('<p>pic</p>');
    expect(d.item(A1)?.revision).toBe(rev);
  });

  it('a Phase 1 app reads as automatic, and a newer body keeps its fields', () => {
    expect(contentFrom({ kind: 'app', title: 'Calc', html: '<html></html>' })).toEqual({
      kind: 'app',
      title: 'Calc',
      html: '<html></html>',
    });
    expect(
      contentFrom({
        kind: 'app',
        title: 'Calc',
        html: '<html></html>',
        literals: { rate: 0.05 },
        run: 'manual',
        sourceRev: 2,
        setupRev: 1,
        output: {
          version: 1,
          outputs: {},
          inputRevs: { '#source': 2 },
          status: 'ok',
          card: '<p>x</p>',
        },
      }),
    ).toMatchObject({
      literals: { rate: 0.05 },
      run: 'manual',
      sourceRev: 2,
      setupRev: 1,
      output: { card: '<p>x</p>', inputRevs: { '#source': 2 } },
    });
  });

  it('applying an MCP app update moves its pinned view, and undo moves it back', () => {
    const mcp = { connection: 'c1', resourceUri: 'ui://price/view', tool: 'price', sha256: 'aaa' };
    const d = board([
      item(N3, { kind: 'note', source: 'x' }, 7),
      item(A1, { kind: 'app', title: 'Price', html: '', mcp }, 4),
    ]);
    d.apply({ type: 'app.output', itemId: A1, outputs: { v: 1 }, status: 'ok' });
    const undo = d.apply({ type: 'app.set', itemId: A1, mcpSha256: 'bbb' });
    const c = d.item(A1)?.content;
    expect(c?.kind === 'app' && c.mcp).toEqual({ ...mcp, sha256: 'bbb' });
    expect(appStates(d).get(A1)).toMatchObject({ state: 'stale' });
    expect(undo).toEqual({ type: 'app.set', itemId: A1, mcpSha256: 'aaa' });
    expect(contentFrom({ kind: 'app', title: 'Price', html: '', mcp })).toMatchObject({ mcp });
  });
});
