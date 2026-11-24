import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followSystemTheme, resolvedTheme, setThemeChoice, themeChoice } from './theme';

/** A controllable `prefers-color-scheme: dark`. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => query);
  return (next: boolean) => {
    dark = next;
    for (const fn of listeners) fn();
  };
}

describe('theme', () => {
  let stop = () => {};

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to System, resolved from the operating system', () => {
    fakeSystem(false);
    stop = followSystemTheme();
    expect(themeChoice()).toBe('system');
    expect(resolvedTheme()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('follows the operating system live while on System', () => {
    const flip = fakeSystem(false);
    stop = followSystemTheme();
    flip(true);
    expect(resolvedTheme()).toBe('dark');
  });

  it('ignores the operating system after an explicit choice, and remembers it', () => {
    const flip = fakeSystem(true);
    stop = followSystemTheme();
    setThemeChoice('light');
    flip(false);
    flip(true);
    expect(resolvedTheme()).toBe('light');
    expect(localStorage.getItem('visarium.theme')).toBe('light');
  });

  it('forgets the key when going back to System', () => {
    fakeSystem(true);
    setThemeChoice('light');
    setThemeChoice('system');
    expect(localStorage.getItem('visarium.theme')).toBeNull();
    expect(resolvedTheme()).toBe('dark');
  });

  it('still applies a choice when storage refuses it, until reload', () => {
    fakeSystem(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    setThemeChoice('light');
    expect(resolvedTheme()).toBe('light');
    expect(themeChoice()).toBe('light');
  });
});
