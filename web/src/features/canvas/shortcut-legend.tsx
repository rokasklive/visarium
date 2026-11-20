import { useState } from 'react';
import { keyLabel, SHORTCUTS, type Shortcut } from './shortcuts';

/**
 * The canvas shortcuts, in the lower-left corner (canvas/shortcut-legend).
 *
 * Chrome that should be there without being looked at: the interface face at
 * 11 px, dimmed ink, no fill, and no pointer events, so a marquee or a drag passes
 * straight through it. Turned off in Settings, per device.
 */

const KEY = 'visarium.shortcutLegend';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Whether the legend is shown on this device, default on. */
export function useShortcutLegend(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  const set = (next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? 'on' : 'off');
    } catch {
      // Storage refused (private window): it still applies until reload.
    }
  };
  return [on, set];
}

/** Below this canvas width the legend would crowd the board, so it stays away. */
const MIN_CANVAS_WIDTH = 640;

export function ShortcutLegend({ readOnly, width }: { readOnly: boolean; width: number }) {
  const [on] = useShortcutLegend();
  if (!on || width < MIN_CANVAS_WIDTH) return null;
  const shown = SHORTCUTS.filter((s) => !(readOnly && s.needsEdit));
  const always = shown.filter((s) => !s.needsSelection);
  const withSelection = shown.filter((s) => s.needsSelection);
  return (
    <dl
      aria-label="Keyboard shortcuts"
      data-testid="shortcut-legend"
      // Above the stats line in the same corner; hidden where it would crowd.
      // One grid, so the selection keys line up with the rest.
      className="pointer-events-none absolute bottom-9 left-2 grid select-none grid-cols-[auto_auto] gap-x-2 text-[11px] leading-4 text-ink-dim opacity-60"
    >
      <Rows shortcuts={always} />
      {withSelection.length > 0 && (
        <>
          <div className="col-span-2 mt-1.5 uppercase tracking-wide text-ink-disabled">
            With a selection
          </div>
          <Rows shortcuts={withSelection} />
        </>
      )}
    </dl>
  );
}

function Rows({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  return shortcuts.map((s) => (
    <div key={`${s.keys.join('+')}:${s.label}`} className="contents">
      <dt className="flex gap-0.5">
        {s.keys.map((k) =>
          k === 'drag' ? (
            <span key={k} className="px-0.5">
              drag
            </span>
          ) : (
            <kbd key={k} className="rounded-sm border border-line px-1 leading-[13px]">
              {keyLabel(k)}
            </kbd>
          ),
        )}
      </dt>
      <dd>{s.label}</dd>
    </div>
  ));
}
