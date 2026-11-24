import { useSyncExternalStore } from 'react';

/**
 * Light or dark (appearance/theme).
 *
 * A person picks System, Light or Dark on this device; System follows the
 * operating system and keeps following it. The inline script in index.html
 * applies the theme before the first paint and this module takes over once the
 * app loads, so the two read the same key and resolve the same way.
 *
 * `<html data-theme>` holds the RESOLVED theme, never "system", and is the one
 * piece of state: app.css keys its light block off it, and anything that has to
 * hand colours to a bitmap (the canvas, diagrams) subscribes with `useTheme()`
 * and re-reads them.
 *
 * ponytail: per device, in localStorage, like the shortcut legend. An account
 * setting would need the server; add it if people ask for it to follow them.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'visarium.theme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
/** What was chosen this session when storage refused to keep it. */
let unsaved: ThemeChoice | undefined;

export function themeChoice(): ThemeChoice {
  if (unsaved) return unsaved;
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function resolve(choice: ThemeChoice): Theme {
  if (choice !== 'system') return choice;
  return globalThis.matchMedia?.(SYSTEM_DARK).matches === false ? 'light' : 'dark';
}

/**
 * Swap colours in one step. Hover and focus transitions would otherwise play
 * the switch as a fade on every control at once, so they are off for the
 * frame the attribute changes in.
 */
function apply(theme: Theme): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const still = document.createElement('style');
  still.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.append(still);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  // Read a style so the swap is committed while transitions are still off.
  void getComputedStyle(root).colorScheme;
  requestAnimationFrame(() => still.remove());
  for (const notify of listeners) notify();
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
    unsaved = undefined;
  } catch {
    // Storage refused (private window): it still applies until reload.
    unsaved = choice;
  }
  apply(resolve(choice));
}

/**
 * Keep System following the operating system, live. Called once from main.tsx;
 * returns the unsubscribe for tests.
 */
export function followSystemTheme(): () => void {
  apply(resolve(themeChoice()));
  const query = globalThis.matchMedia?.(SYSTEM_DARK);
  if (!query) return () => {};
  const onChange = () => {
    if (themeChoice() === 'system') apply(resolve('system'));
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The theme on screen now; re-renders the caller when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, resolvedTheme, () => 'dark');
}
