import { afterEach, describe, expect, it } from 'vitest';
import { canvasTheme } from './canvas-theme';

const NAMES = [
  'item',
  'item-edge',
  'group-edge',
  'ink-dim',
  'line-strong',
  'grid',
  'surface-sunken',
  'link-faded',
  'accent',
  'accent-wash',
  'surface',
  ...Array.from({ length: 6 }, (_, i) => `presence-${i}`),
];

/** Every token the canvas reads, valued `<theme>-<name>` so a read says which theme it came from. */
function stylesheet(): HTMLStyleElement {
  const decls = (theme: string) => NAMES.map((n) => `--color-${n}: ${theme}-${n};`).join('');
  const style = document.createElement('style');
  style.textContent = `:root { ${decls('dark')} } :root[data-theme="light"] { ${decls('light')} }`;
  document.head.append(style);
  return style;
}

describe('canvasTheme (appearance/theme)', () => {
  let style: HTMLStyleElement | undefined;
  afterEach(() => {
    style?.remove();
    delete document.documentElement.dataset.theme;
  });

  it('reads the colours of the theme on screen, and again after a switch', () => {
    style = stylesheet();
    document.documentElement.dataset.theme = 'dark';
    expect(canvasTheme().ground).toBe('dark-surface-sunken');
    document.documentElement.dataset.theme = 'light';
    expect(canvasTheme().ground).toBe('light-surface-sunken');
    expect(canvasTheme().presence[2]).toBe('light-presence-2');
    document.documentElement.dataset.theme = 'dark';
    expect(canvasTheme().accent).toBe('dark-accent');
  });
});
