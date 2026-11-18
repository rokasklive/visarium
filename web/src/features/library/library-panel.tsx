import { useState } from 'react';
import { useLibrary } from '~/api/assets';
import { useCollections } from '~/api/collections';
import { useUiStore } from '~/app/ui-store';
import { LibraryGrid } from './library-grid';

/**
 * The library, beside the canvas.
 *
 * Not a second library: the same `useLibrary` query under the same key, so
 * opening a board after visiting `/library` is served from cache, and the same
 * `LibraryGrid` at a smaller cell. The difference between this and the full
 * route is a prop and a container.
 *
 * `/library` is where you go to organise; this is where you go to work.
 */

/** Small enough that a 224px column fits two columns and still identifies a reference. */
// 63, not 64: three columns need 3 cells + 2 gaps, and the 224px sidebar less
// its padding and border leaves 207px. At 64 the third column misses by 1px.
const PANEL_CELL_SIZE = 63;

export function LibraryPanel() {
  const filter = useUiStore((s) => s.libraryFilter);
  const setFilter = useUiStore((s) => s.setLibraryFilter);
  const placeAssets = useUiStore((s) => s.placeAssets);
  const library = useLibrary(filter);
  const collections = useCollections();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const assets = library.data?.pages.flatMap((page) => page.assets) ?? [];

  /**
   * A click places, rather than only selecting.
   *
   * The full route's click is selection because organising is what that screen
   * does. Here the reason to touch a thumbnail is to put it on the board, so a
   * plain click does that and a modifier builds the multi-selection a drag
   * carries. Placement goes to the viewport centre — the canvas decides where
   * that is, because only it knows the camera.
   */
  const select = (assetId: string, additive: boolean) => {
    if (additive) {
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(assetId)) next.add(assetId);
        return next;
      });
      return;
    }
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (!asset || !placeAssets) return;
    const chosen = selected.has(assetId)
      ? assets.filter((candidate) => selected.has(candidate.assetId))
      : [asset];
    placeAssets(chosen);
  };

  return (
    <section aria-label="Library" className="mb-3 flex min-h-0 flex-col">
      <h2 className="mb-1 text-[11px] uppercase tracking-wide text-ink-dim">Library</h2>

      <input
        type="search"
        value={filter.q}
        onChange={(event) => setFilter({ ...filter, q: event.target.value })}
        placeholder="Search filenames"
        aria-label="Search the library"
        className="mb-1 w-full rounded border border-line bg-surface-raised px-1.5 py-0.5 text-ink placeholder:text-ink-disabled focus:border-line-strong focus:outline-none"
      />

      {collections.data && collections.data.length > 0 && (
        <select
          value={filter.collection ?? ''}
          onChange={(event) =>
            setFilter({ ...filter, collection: event.target.value || undefined })
          }
          aria-label="Filter by collection"
          className="mb-1 w-full rounded border border-line bg-surface-raised px-1.5 py-0.5 text-ink-dim"
        >
          <option value="">everything</option>
          {collections.data.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      )}

      {/* Fixed rather than flexed: the panel is a scroller inside a scroller,
          and a height that follows its contents would grow past the sidebar. */}
      <div className="h-64">
        {library.isError && <p className="text-ink">the library could not be loaded</p>}
        {library.isPending && <p className="text-ink-dim">loading…</p>}
        {library.isSuccess && assets.length === 0 && (
          <p className="text-ink-dim">
            {filter.q || filter.collection ? 'Nothing matches.' : 'No images yet. Drop some here.'}
          </p>
        )}
        {assets.length > 0 && (
          <LibraryGrid
            assets={assets}
            selected={selected}
            onSelect={select}
            cellSize={PANEL_CELL_SIZE}
            onReachEnd={() => {
              if (library.hasNextPage && !library.isFetchingNextPage) void library.fetchNextPage();
            }}
          />
        )}
      </div>

      {/* Said once, in words, rather than repeated on every cell as a tooltip. */}
      {assets.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-dim">
          Click to place · drag onto the board · {modifierName()}-click to multi-select
        </p>
      )}
    </section>
  );
}

function modifierName(): string {
  return globalThis.navigator?.platform?.startsWith('Mac') ? 'Cmd' : 'Ctrl';
}
