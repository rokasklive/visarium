import { useState } from 'react';

/**
 * Experiments a person turns on, per device (Settings → Labs). Off by default.
 *
 * Canvas apps (ADR-0034, openspec canvas-apps-poc): interactive app items run
 * in a sandbox. Until the proof of concept is done they stay behind this.
 */

const CANVAS_APPS = 'visarium.labs.canvasApps';

export function canvasAppsOn(): boolean {
  try {
    return localStorage.getItem(CANVAS_APPS) === 'on';
  } catch {
    return false;
  }
}

export function useCanvasApps(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(canvasAppsOn);
  const set = (next: boolean) => {
    setOn(next);
    try {
      if (next) localStorage.setItem(CANVAS_APPS, 'on');
      else localStorage.removeItem(CANVAS_APPS);
    } catch {
      // Storage refused (private window): it still applies until reload.
    }
  };
  return [on, set];
}
