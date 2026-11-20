import { useEffect, useRef } from 'react';
import { useUiStore } from '~/app/ui-store';

/**
 * The quick-search field (canvas/quick-search): under the canvas toolbar,
 * while search is open.
 *
 * It holds the keys while it has focus (the canvas handler ignores a focused
 * field): Enter and ↓ step forward, Shift+Enter and ↑ back, Esc closes on the
 * current result. `onClose` is the canvas', which selects that result.
 */
export function SearchBar({ onClose }: { onClose: () => void }) {
  const search = useUiStore((s) => s.search);
  const setQuery = useUiStore((s) => s.setSearchQuery);
  const step = useUiStore((s) => s.stepSearch);
  const input = useRef<HTMLInputElement>(null);
  const focus = search?.focus;

  useEffect(() => {
    if (focus === undefined) return;
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  if (!search) return null;
  const total = search.results.length;
  return (
    <div
      className="absolute top-12 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded border border-line-strong bg-surface/95 px-2 py-1 text-[11px]"
      data-testid="canvas-search"
    >
      <input
        ref={input}
        type="search"
        aria-label="Search the board"
        placeholder="Search the board"
        value={search.query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
          }
        }}
        className="w-56 bg-transparent text-ink outline-none placeholder:text-ink-dim"
      />
      <span className="tabular-nums text-ink-dim" data-testid="canvas-search-count">
        {total === 0 ? 0 : search.current + 1} / {total}
      </span>
    </div>
  );
}
