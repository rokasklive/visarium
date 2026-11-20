import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyLabel, SHORTCUTS, SPACE_TAP_MS, SpaceTap } from './shortcuts';

describe('the shortcut table', () => {
  // The legend reads the table and the handler is inline code: every entry
  // must name something the handler actually contains.
  const handler = readFileSync(join(__dirname, 'canvas-surface.tsx'), 'utf8');

  it.each(SHORTCUTS.map((s) => [s.keys.join('+'), s.handles]))(
    '%s is handled by the canvas',
    (_keys, handles) => {
      expect(handler).toContain(handles);
    },
  );

  it('shows the modifier for the platform', () => {
    expect(keyLabel('Mod', true)).toBe('⌘');
    expect(keyLabel('Mod', false)).toBe('Ctrl');
    expect(keyLabel('F', false)).toBe('F');
  });
});

describe('a Space tap', () => {
  it('opens on a quick clean press', () => {
    const tap = new SpaceTap();
    tap.down(0, false);
    expect(tap.up(100)).toBe(true);
  });

  it('is not a tap when the press is held past the limit', () => {
    const tap = new SpaceTap();
    tap.down(0, false);
    expect(tap.up(SPACE_TAP_MS + 1)).toBe(false);
  });

  it('is not a tap when a drag or another key came between', () => {
    const tap = new SpaceTap();
    tap.down(0, false);
    tap.interrupt();
    expect(tap.up(50)).toBe(false);
  });

  it('ignores auto-repeat as part of the same press', () => {
    const tap = new SpaceTap();
    tap.down(0, false);
    tap.down(40, true);
    tap.down(80, true);
    expect(tap.up(120)).toBe(true);
    // A hold that repeats past the limit is measured from the first keydown.
    tap.down(0, false);
    tap.down(200, true);
    expect(tap.up(300)).toBe(false);
  });

  it('is not a tap without a keydown first', () => {
    expect(new SpaceTap().up(10)).toBe(false);
  });
});
