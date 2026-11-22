/**
 * Editing an object in place (spec: notes, diagrams, checklists; design D7).
 *
 * A temporary DOM field laid exactly over the object: same place, same width
 * in world units, scaled by the camera's zoom and turned by the item's
 * rotation, so editing happens where the thing is, with no panel or dialog.
 * It exists only while editing; at rest the canvas draws the bitmap.
 */

import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Where the field sits: screen px of the item-local point it starts at. */
export interface Placement {
  readonly left: number;
  readonly top: number;
  /** Degrees, the item's rotation. */
  readonly rotation: number;
  readonly zoom: number;
  /** World units: the field is laid out at this width, then scaled by zoom. */
  readonly width: number;
}

function frame(p: Placement): CSSProperties {
  return {
    position: 'absolute',
    left: p.left,
    top: p.top,
    width: p.width,
    transformOrigin: '0 0',
    transform: `rotate(${p.rotation}deg) scale(${p.zoom})`,
  };
}

/** Calls `fn` once, however many of Escape, blur and unmount fire. */
function useOnce<T extends unknown[]>(fn: (...args: T) => void) {
  const done = useRef(false);
  const latest = useRef(fn);
  latest.current = fn;
  return (...args: T) => {
    if (done.current) return;
    done.current = true;
    latest.current(...args);
  };
}

/**
 * A note's Markdown or a diagram's source, as plain text. `onChange` hears
 * every edit (the caller debounces its saves); `onDone` hears the final text
 * once, on Escape or when focus leaves.
 */
export function SourceEditor({
  placement,
  initial,
  error,
  label,
  onChange,
  onDone,
}: {
  placement: Placement;
  initial: string;
  /** A diagram's parse error, shown while its source is being edited (spec). */
  error?: string | undefined;
  label: string;
  onChange: (text: string) => void;
  onDone: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(initial);
  const done = useOnce(onDone);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grows with its text, like the object it stands in for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div style={frame(placement)} data-testid="object-editor">
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            done(value);
          }
        }}
        onBlur={() => done(value)}
        className="block w-full resize-none overflow-hidden rounded border border-line-strong bg-surface-raised px-2 py-1.5 font-mono text-[13px] text-ink leading-[1.45] outline-none focus:border-accent"
      />
      {error ? (
        <p
          role="alert"
          className="mt-1 rounded bg-surface-raised px-2 py-1 font-mono text-[11px] text-ink-dim leading-snug"
        >
          {error.split('\n')[0]}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One line of a checklist: a task's text or the title. Enter commits and asks
 * for the next line; Backspace in an empty field asks to remove it.
 */
export function FieldEditor({
  placement,
  initial,
  label,
  fontSize,
  bold,
  onEnter,
  onBackspaceEmpty,
  onDone,
}: {
  placement: Placement;
  initial: string;
  label: string;
  fontSize: number;
  bold?: boolean;
  onEnter: (text: string) => void;
  onBackspaceEmpty?: () => void;
  onDone: (text: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initial);
  const done = useOnce((how: 'enter' | 'backspace' | 'leave', text: string) => {
    if (how === 'enter') onEnter(text);
    else if (how === 'backspace') onBackspaceEmpty?.();
    else onDone(text);
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div style={frame(placement)} data-testid="object-field">
      <input
        ref={ref}
        aria-label={label}
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done('enter', value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done('leave', value);
          } else if (e.key === 'Backspace' && value === '' && onBackspaceEmpty) {
            e.preventDefault();
            done('backspace', value);
          }
        }}
        onBlur={() => done('leave', value)}
        style={{ fontSize, fontWeight: bold ? 600 : 400 }}
        className="block w-full rounded border border-accent bg-surface-raised px-1 py-0 text-ink leading-[1.35] outline-none"
      />
    </div>
  );
}

/**
 * The states a status chip offers (canvas/note-status): a short menu under
 * the chip. Choosing one calls `onPick`; Escape or leaving it closes it.
 */
export function StatusMenu({
  placement,
  states,
  onPick,
  onDone,
}: {
  placement: Placement;
  states: readonly { readonly state: string; readonly label: string }[];
  onPick: (state: string) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const done = useOnce((state?: string) => (state ? onPick(state) : onDone()));
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Change status"
      data-testid="status-menu"
      style={{ ...frame(placement), width: 'auto' }}
      className="flex flex-col rounded border border-line-strong bg-surface-raised py-1 text-[12px] text-ink"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done();
        }
      }}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node | null)) done();
      }}
    >
      {states.map((s) => (
        <button
          key={s.state}
          type="button"
          role="menuitem"
          className="px-3 py-0.5 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => done(s.state)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
