import { describe, expect, it } from 'vitest';
import { blockNames, nameBlock, newBlockId, slug, sourceBlocks } from './blocks';

const NOTE = [
  '## Bounds and fallbacks',
  '',
  'The adapter retries twice. ^retry',
  '',
  'Then it gives up,',
  'and says why.',
  '',
  '- First item ^one',
  '- Second item',
  '  continues here',
  '',
  '```',
  'Not a block ^nope',
  '```',
  '',
  '## Bounds and fallbacks',
].join('\n');

describe('note blocks (canvas/text-anchors)', () => {
  it('finds headings, paragraphs and list items in reading order, skipping code', () => {
    const blocks = sourceBlocks(NOTE);
    expect(blocks.map((b) => [b.kind, b.name])).toEqual([
      ['heading', 'bounds-and-fallbacks'],
      ['paragraph', '^retry'],
      ['paragraph', undefined],
      ['item', '^one'],
      ['item', undefined],
      ['heading', 'bounds-and-fallbacks-1'],
    ]);
    expect(blocks[4]?.last).toBe(9);
    expect(blockNames(NOTE)).not.toContain('^nope');
  });

  it('slugs a heading as GitHub does', () => {
    expect(slug('Bounds, and *fallbacks*!')).toBe('bounds-and-fallbacks');
  });

  it('names a passage at the end of its last line, only when the drawing agrees', () => {
    const named = nameBlock(NOTE, 2, 'Then it gives up, and says why.', () => 0.5);
    expect(named?.name).toMatch(/^\^[0-9a-z]{4}$/);
    expect(named?.source.split('\n')[5]).toBe(`and says why. ${named?.name}`);
    expect(blockNames(named?.source ?? '')).toContain(named?.name);
    // Some other text: the source and drawing disagree, so nothing is named.
    expect(nameBlock(NOTE, 2, 'Something else entirely')).toBeUndefined();
    // Already named, or a heading: nothing to do.
    expect(nameBlock(NOTE, 1, 'The adapter retries twice.')).toBeUndefined();
    expect(nameBlock(NOTE, 0, 'Bounds and fallbacks')).toBeUndefined();
  });

  it('never reuses a name the note has', () => {
    let n = 0;
    // The first draw collides with ^one's base36 neighbour; the second does not.
    const draws = [0, 0.9];
    const id = newBlockId('Text ^0000', () => draws[n++] ?? 0.9);
    expect(id).not.toBe('^0000');
  });
});
