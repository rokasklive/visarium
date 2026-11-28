import { describe, expect, it } from 'vitest';
import { isHtmlDocument, preview, staleReasons } from './app-inspector';

describe('the app inspector (canvas/app-inspector)', () => {
  it('names why an app is stale: its inputs, its source, how they are set up', () => {
    const refOf = (id: string) => ({ 'n-1': 'n1', 'n-2': 'n2', 'a-1': 'a1' })[id] ?? '?';
    expect(
      staleReasons(
        {
          state: 'stale',
          moved: [
            { itemId: 'n-1', was: 3, now: 4 },
            { itemId: 'n-2', now: 1 },
            { itemId: 'a-1', was: 2 },
            { itemId: '#source', was: 0, now: 1 },
            { itemId: '#setup', was: 0, now: 2 },
          ],
        },
        refOf,
      ),
    ).toBe('n1 changed, n2 connected, a1 disconnected, source changed, inputs changed');
    expect(staleReasons({ state: 'fresh' }, refOf)).toBe('');
  });

  it('previews a value short, and knows a whole HTML document', () => {
    expect(preview({ age: 40 })).toBe('{"age":40}');
    expect(preview('x'.repeat(100), 10)).toBe(`"${'x'.repeat(8)}…`);
    expect(isHtmlDocument('  <!DOCTYPE html><p>')).toBe(true);
    expect(isHtmlDocument('<html lang="en">')).toBe(true);
    expect(isHtmlDocument('<p>no</p>')).toBe(false);
  });
});
