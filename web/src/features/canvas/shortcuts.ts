/**
 * Every canvas shortcut, in the order the legend shows them (canvas/shortcut-legend).
 *
 * The key handler in `canvas-surface.tsx` keeps its own inline branches, which
 * are full of special cases; this table is what a person reads. A test scans
 * the handler for each entry's `handles` so the two cannot drift apart.
 */
export interface Shortcut {
  /** Keys as shown, `Mod` standing for ⌘ or Ctrl. */
  readonly keys: readonly string[];
  readonly label: string;
  /** Only does something with a selection. */
  readonly needsSelection?: boolean;
  /** Changes the board, so it does nothing on a read-only one. */
  readonly needsEdit?: boolean;
  /** A literal the key handler must contain for this entry (the drift test). */
  readonly handles: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Space'], label: 'Search', handles: 'spaceTap' },
  { keys: ['Mod', 'F'], label: 'Search', handles: "key.toLowerCase() === 'f'" },
  { keys: ['Space', 'drag'], label: 'Pan', handles: 'spaceHeld.current = true' },
  { keys: ['F'], label: 'Frame selection or board', handles: 'frameView()' },
  { keys: ['P'], label: 'Pause GIFs', handles: "key.toLowerCase() === 'p'" },
  { keys: ['Mod', 'Z'], label: 'Undo', needsEdit: true, handles: "key.toLowerCase() === 'z'" },
  { keys: ['Mod', 'A'], label: 'Select all', handles: "key.toLowerCase() === 'a'" },
  { keys: ['Esc'], label: 'Deselect', handles: "key === 'Escape'" },
  // Not a key, but undiscoverable otherwise: a click selects the whole group.
  { keys: ['hold'], label: 'Edit one in a group', needsEdit: true, handles: 'holdToPick(' },
  {
    keys: ['Mod', 'D'],
    label: 'Duplicate',
    needsSelection: true,
    needsEdit: true,
    handles: "key.toLowerCase() === 'd'",
  },
  {
    keys: ['Mod', 'C'],
    label: 'Copy image',
    needsSelection: true,
    handles: "mod && event.key.toLowerCase() === 'c'",
  },
  {
    keys: ['Del'],
    label: 'Delete',
    needsSelection: true,
    needsEdit: true,
    handles: "event.key === 'Delete'",
  },
  {
    keys: ['0–9'],
    label: 'Opacity',
    needsSelection: true,
    needsEdit: true,
    handles: 'DIGITS[event.key]',
  },
  {
    keys: ['⇧', 'H/V'],
    label: 'Flip',
    needsSelection: true,
    needsEdit: true,
    handles: 'FLIP_KEYS[',
  },
  {
    keys: ['C'],
    label: 'Crop image',
    needsSelection: true,
    needsEdit: true,
    handles: "!mod && !event.altKey && event.key.toLowerCase() === 'c'",
  },
  { keys: ['F2'], label: 'Label group', needsSelection: true, needsEdit: true, handles: "'F2'" },
  { keys: ['F4'], label: 'Frame group', needsSelection: true, needsEdit: true, handles: "'F4'" },
  { keys: ['←↑→↓'], label: 'Nudge', needsSelection: true, needsEdit: true, handles: 'NUDGES[' },
];

/** Whether this is a Mac, where the modifier is ⌘ rather than Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}

/** One key as shown on this platform. */
export function keyLabel(key: string, mac = isMac()): string {
  if (key !== 'Mod') return key;
  return mac ? '⌘' : 'Ctrl';
}

/** The longest press of Space that still counts as a tap rather than a hold. */
export const SPACE_TAP_MS = 250;

/**
 * Tells a tap of Space (search, canvas/quick-search) from a hold (pan).
 *
 * A tap is a press released within `SPACE_TAP_MS` with nothing between: no
 * other key, no pointer press, no drag. Auto-repeat keydowns are part of the
 * same press, not a new one.
 */
export class SpaceTap {
  #downAt: number | null = null;
  #clean = false;

  down(now: number, repeat: boolean): void {
    if (repeat && this.#downAt !== null) return;
    this.#downAt = now;
    this.#clean = !repeat;
  }

  /** Another key, a pointer press or a pan while Space is down. */
  interrupt(): void {
    this.#clean = false;
  }

  /** The release: true when it was a tap. */
  up(now: number): boolean {
    const tap = this.#clean && this.#downAt !== null && now - this.#downAt < SPACE_TAP_MS;
    this.#downAt = null;
    this.#clean = false;
    return tap;
  }
}
