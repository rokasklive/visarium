import {
  asCanvasId,
  asItemId,
  CanvasDocument,
  type CanvasItem,
  type CanvasItemContent as ItemContent,
  newGroupId,
} from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { noteHtml } from './objects/layout';
import { loadMarkdown } from './objects/loaders';
import { fallbackText, findResults, occurrences, textIndex } from './search';

function html(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('the searchable text', () => {
  it('is the drawn text, passages apart, markup gone', () => {
    const { text } = textIndex(
      html('<h1>Auth</h1><p>calls <em>the</em> cache</p><style>p{}</style>'),
    );
    expect(text).toBe('Auth\ncalls the cache');
  });

  it('never matches across two passages', () => {
    const { text } = textIndex(html('<p>auth</p><p>server</p>'));
    expect(occurrences(text, 'auth server')).toEqual([]);
    expect(occurrences(text, 'server')).toHaveLength(1);
  });

  it('matches inside inline markup', () => {
    const { text } = textIndex(html('<p><strong>auth</strong> server</p>'));
    expect(occurrences(text, 'auth server')).toEqual([0]);
  });

  it('counts each occurrence, case-insensitively', () => {
    expect(occurrences('Cache, cache and CACHE', 'cache')).toEqual([0, 7, 17]);
    expect(occurrences('anything', '  ')).toEqual([]);
  });

  it('reads a diagram by its labels, not its syntax', () => {
    const item = object({
      kind: 'diagram',
      lang: 'mermaid',
      source: 'graph TD\n  A[Auth Server] --> B("Token cache")',
    });
    const text = fallbackText(item);
    expect(occurrences(text, 'auth')).toHaveLength(1);
    expect(occurrences(text, 'graph')).toEqual([]);
  });

  it('reads an off-screen note through the same renderer as a drawn one', async () => {
    const md = await loadMarkdown();
    // Led by a throwaway paragraph: happy-dom's DOMPurify drops the first
    // element's tag, which no browser does.
    const text = fallbackText(
      object({ kind: 'note', source: 'Intro\n\nPlan ^p1\n\n- [ ] **auth** server' }),
      noteHtml(md),
    );
    expect(text.endsWith('Plan\nauth server')).toBe(true);
    expect(occurrences(text, '^p1')).toEqual([]);
    expect(occurrences(text, '**')).toEqual([]);
  });
});

describe('the results', () => {
  const canvas = asCanvasId('board-search');

  function board(): CanvasDocument {
    const doc = new CanvasDocument(canvas);
    const place = (id: string, x: number, y: number, content: ItemContent) =>
      doc.apply({
        type: 'item.create',
        itemId: asItemId(id),
        transform: { x, y, width: 100, height: 100, rotation: 0 },
        z: 1,
        content,
      });
    place('lower', 0, 500, { kind: 'note', source: 'cache' });
    place('right', 500, 0, { kind: 'note', source: 'cache cache' });
    place('left', 0, 0, {
      kind: 'checklist',
      title: 'Cache work',
      tasks: [{ id: 't1', text: 'Warm the cache', state: 'todo' }],
    });
    place('other', 0, 1000, { kind: 'note', source: 'nothing here' });
    doc.apply({
      type: 'group.create',
      groupId: newGroupId(),
      memberIds: [asItemId('other')],
      label: 'Cache layer',
    });
    return doc;
  }

  it('is every occurrence in board order', () => {
    const doc = board();
    const results = findResults(doc, 'cache', (item) => fallbackText(item));
    expect(results.map((r) => `${r.target.id}#${r.nth}`)).toEqual([
      'left#0',
      'left#1',
      'right#0',
      'right#1',
      'lower#0',
      expect.stringMatching(/#0$/),
    ]);
    expect(results.at(-1)?.target.kind).toBe('group');
  });

  it('is nothing for an empty query', () => {
    expect(findResults(board(), '', (item) => fallbackText(item))).toEqual([]);
  });
});

function object(content: ItemContent): CanvasItem {
  return {
    id: asItemId('obj'),
    transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    z: 1,
    content,
  } as CanvasItem;
}
