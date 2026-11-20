import { asItemId, type CanvasItem, DEFAULT_APPEARANCE, FULL_CROP } from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { textScaleFor } from '../canvas-surface';
import { laidWidth } from './layout';
import { layoutKey } from './store';

const note = (width: number, textScale?: number): CanvasItem => ({
  id: asItemId('n'),
  transform: { x: 0, y: 0, width, height: 100, rotation: 0 },
  z: 0,
  content: { kind: 'note', source: 'Two lines of text that wrap somewhere.' },
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
  ...(textScale !== undefined ? { textScale } : {}),
});

describe('text scale (canvas/text-scaling)', () => {
  it('lays a scaled note out at its width over its scale: same drawing, same breaks', () => {
    expect(laidWidth(note(320))).toBe(320);
    expect(laidWidth(note(640, 2))).toBe(320);
    expect(layoutKey(note(640, 2))).toBe(layoutKey(note(320)));
    expect(layoutKey(note(640))).not.toBe(layoutKey(note(320)));
  });

  it('does not scale a diagram, which already scales with its box', () => {
    const d = {
      ...note(640, 2),
      content: { kind: 'diagram' as const, lang: 'mermaid' as const, source: 'x' },
    };
    expect(laidWidth(d)).toBe(640);
  });

  it('scales the text from a corner handle and never from a side', () => {
    const n = note(320);
    const wider = { ...n.transform, width: 640, height: 200 };
    expect(textScaleFor(n, wider, 'bottom-right')).toEqual({ textScale: 2 });
    expect(textScaleFor(n, wider, 'middle-right')).toEqual({});
    expect(textScaleFor(note(640, 2), { ...wider, width: 320 }, 'top-left')).toEqual({
      textScale: 1,
    });
    // Held to the schema's bounds.
    expect(textScaleFor(n, { ...wider, width: 320 * 20 }, 'top-right')).toEqual({ textScale: 8 });
    const image = {
      ...n,
      content: { kind: 'placeholder' as const, intrinsicWidth: 1, intrinsicHeight: 1 },
    };
    expect(textScaleFor(image, wider, 'bottom-right')).toEqual({});
  });
});
