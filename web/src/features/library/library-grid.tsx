import { pickDerivative } from '@visarium/canvas-core';
import { useEffect, useRef, useState } from 'react';
import type { LibraryAsset } from '~/api/assets';
import { useElementSize } from '~/components/use-element-size';
import { ASSET_DRAG_TYPE, type DraggedAsset } from '~/features/canvas/capture';
import { gridWindow } from './grid-window';

/**
 * The library grid.
 *
 * Two rules make this cheap at several thousand assets. Cells are a fixed size,
 * so the window is arithmetic (`grid-window.ts`). And each thumbnail is fetched
 * at the smallest derivative tier that covers the cell in *physical* pixels —
 * `pickDerivative`, the same function the canvas uses, rather than a hardcoded
 * 64 that is soft on every retina display.
 *
 * The browser's own HTTP cache holds these; nothing here touches the canvas
 * bitmap cache. That cache exists to hold decoded ImageBitmaps under a byte
 * budget for blitting, and pushing thumbnails through it would evict canvas
 * bitmaps to cache what the browser already caches better.
 */

/** A reference is recognised, not read. Small enough to scan, large enough to identify. */
export const CELL_SIZE = 96;
const GAP = 8;

/** One row above and below, so a flick-scroll does not show holes. */
const OVERSCAN_ROWS = 1;

/** Rows from the end at which the next page is asked for. */
const PREFETCH_ROWS = 3;

interface LibraryGridProps {
  readonly assets: readonly LibraryAsset[];
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (assetId: string, additive: boolean) => void;
  readonly onReachEnd: () => void;
  /**
   * Cell edge in CSS pixels. A prop rather than a constant so the sidebar panel
   * is this grid at a smaller density — the grid never learns which panel it is
   * in, and the derivative tier follows from the size rather than from a flag.
   */
  readonly cellSize?: number;
  /**
   * Mark what each asset is used on.
   *
   * Only the full route asks for it: the sidebar panel is for placing, where
   * "on 3 boards" is noise, and the deleted view's cells have nothing left to
   * be used by.
   */
  readonly showUsage?: boolean;
}

export function LibraryGrid({
  assets,
  selected,
  onSelect,
  onReachEnd,
  cellSize = CELL_SIZE,
  showUsage = false,
}: LibraryGridProps) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);

  const view = gridWindow({
    count: assets.length,
    viewportWidth: size.width,
    viewportHeight: size.height,
    scrollTop,
    cellSize,
    gap: GAP,
    overscanRows: OVERSCAN_ROWS,
  });

  // The tier is chosen once per render rather than per cell: every cell is the
  // same size, so they would all reach the same answer.
  const tier = pickDerivative(cellSize * (globalThis.devicePixelRatio ?? 1));

  // Asking for the next page is a side effect of having scrolled near the end,
  // not of rendering — so it runs in an effect and the fetch is left to the
  // query layer to deduplicate.
  const reachedEnd = view.endIndex >= assets.length - view.columns * PREFETCH_ROWS;
  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;
  useEffect(() => {
    if (reachedEnd && assets.length > 0) onReachEndRef.current();
  }, [reachedEnd, assets.length]);

  // Read by the drag handler, which is attached per cell and must not close
  // over the selection as it was when the cell last rendered.
  const dragSetRef = useRef({ assets, selected });
  dragSetRef.current = { assets, selected };

  const visible = assets.slice(view.firstIndex, view.endIndex);

  return (
    <div
      ref={ref}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="h-full overflow-y-auto"
      data-testid="library-scroller"
    >
      {/* Sized to every result, not to the instantiated slice, so the scrollbar
          describes the library rather than the part of it currently in the DOM. */}
      <div style={{ height: view.totalHeight }} className="relative">
        <ul
          style={{
            transform: `translateY(${view.offsetY}px)`,
            gridTemplateColumns: `repeat(${view.columns}, ${cellSize}px)`,
            gap: GAP,
          }}
          className="absolute inset-x-0 top-0 grid justify-center"
        >
          {visible.map((asset) => (
            <li key={asset.assetId} className="relative">
              <button
                type="button"
                aria-pressed={selected.has(asset.assetId)}
                title={asset.filename}
                onClick={(event) => onSelect(asset.assetId, event.metaKey || event.ctrlKey)}
                draggable
                onDragStart={(event) => writeDrag(event.dataTransfer, asset, dragSetRef.current)}
                style={{ width: cellSize, height: cellSize }}
                className={`block overflow-hidden rounded border bg-surface-raised ${
                  selected.has(asset.assetId) ? 'border-accent' : 'border-line'
                }`}
              >
                <img
                  src={
                    tier === 'original'
                      ? `/api/assets/${asset.assetId}/content`
                      : `/api/assets/${asset.assetId}/derivatives/${tier}`
                  }
                  alt={asset.filename}
                  // Decoding off the main thread and lazily: a fast scroll must
                  // not be blocked by images the user has already passed.
                  loading="lazy"
                  decoding="async"
                  width={cellSize}
                  height={cellSize}
                  className="h-full w-full object-contain"
                />
              </button>
              {showUsage && (
                /*
                 * What a person cleaning up is hunting. Absence would be the
                 * weaker signal — a cell with no badge reads as a cell whose
                 * badge has not loaded — so the unused ones say so.
                 *
                 * Absolutely positioned, so the grid's arithmetic stays the
                 * fixed square `gridWindow` computes rows from.
                 */
                <span
                  className={`pointer-events-none absolute right-0 bottom-0 bg-surface/90 px-1 text-[11px] tabular-nums ${
                    asset.boards === 0 ? 'text-ink' : 'text-ink-dim'
                  }`}
                >
                  {asset.boards === 0 ? 'unused' : `on ${asset.boards}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * What a dragged thumbnail carries.
 *
 * Dragging a cell that is part of the selection drags the whole selection;
 * dragging one that is not drags only it, without disturbing the selection —
 * the behaviour every file manager has, and the one people already expect.
 */
function writeDrag(
  transfer: DataTransfer,
  asset: LibraryAsset,
  { assets, selected }: { assets: readonly LibraryAsset[]; selected: ReadonlySet<string> },
): void {
  const dragging = selected.has(asset.assetId)
    ? assets.filter((candidate) => selected.has(candidate.assetId))
    : [asset];
  const payload: DraggedAsset[] = dragging.map((a) => ({
    assetId: a.assetId,
    width: a.width,
    height: a.height,
  }));
  transfer.setData(ASSET_DRAG_TYPE, JSON.stringify(payload));
  transfer.effectAllowed = 'copy';
}
