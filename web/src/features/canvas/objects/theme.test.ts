import { asItemId, type CanvasItem, DEFAULT_APPEARANCE, FULL_CROP } from '@visarium/canvas-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withPlantUmlStyle } from './layout';
import { loadMermaid, type MermaidPalette } from './loaders';
import { layoutKey } from './store';

const initialize = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize } }));

const note: CanvasItem = {
  id: asItemId('n'),
  transform: { x: 0, y: 0, width: 320, height: 100, rotation: 0 },
  z: 0,
  content: { kind: 'note', source: 'Ink is drawn into the bitmap.' },
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
};

const palette = (ink: string): MermaidPalette => ({
  ink,
  inkDim: ink,
  item: ink,
  lineStrong: ink,
  surface: ink,
});

describe('objects follow the theme (appearance/theme, canvas/diagrams)', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  // A new key is what makes the store lay every object out again on a switch,
  // with the last drawing kept on screen meanwhile, and the bitmap cache keep
  // one bitmap per theme.
  it('gives an object a different layout key in each theme', () => {
    document.documentElement.dataset.theme = 'dark';
    const dark = layoutKey(note);
    document.documentElement.dataset.theme = 'light';
    expect(layoutKey(note)).not.toBe(dark);
    document.documentElement.dataset.theme = 'dark';
    expect(layoutKey(note)).toBe(dark);
  });

  it('initialises Mermaid again when the palette changes, and only then', async () => {
    const dark = palette('#eeeeee');
    const light = palette('#222222');
    await loadMermaid(dark, true);
    await loadMermaid(dark, true);
    expect(initialize).toHaveBeenCalledTimes(1);

    await loadMermaid(light, false);
    expect(initialize).toHaveBeenCalledTimes(2);
    const config = initialize.mock.calls[1]?.[0];
    expect(config.themeVariables.darkMode).toBe(false);
    expect(config.themeVariables.primaryTextColor).toBe('#222222');
  });

  it("puts the palette after PlantUML's start line, before the person's own lines", () => {
    const lines = withPlantUmlStyle(
      ['@startuml', 'skinparam ArrowColor red', 'A -> B', '@enduml'],
      palette('#222222'),
    );
    expect(lines[0]).toBe('@startuml');
    expect(lines[1]).toBe('<style>');
    const end = lines.indexOf('</style>');
    expect(lines.slice(1, end).join('\n')).toContain('FontColor #222222');
    // Theirs comes after ours, so it still wins.
    expect(lines.slice(end + 1)).toEqual(['skinparam ArrowColor red', 'A -> B', '@enduml']);
  });

  it('leaves a source with no start line for PlantUML to refuse', () => {
    expect(withPlantUmlStyle(['A -> B'], palette('#222222'))).toEqual(['A -> B']);
  });
});
