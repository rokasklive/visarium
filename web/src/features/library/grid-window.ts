/**
 * Which cells of a uniform grid are worth instantiating.
 *
 * The library is the first screen in this product that renders a list whose
 * length the user controls, and the failure mode is the one the canvas spent M01
 * avoiding: several thousand elements and a scroll that stutters. The answer is
 * the same answer — draw a bounded window, not the whole set (invariant 8, in
 * the DOM rather than in Konva).
 *
 * No virtualisation library, deliberately. Cells are a fixed size by
 * construction, so rows are a uniform height and the visible slice is
 * arithmetic. A windowing library earns its place when cells stop being
 * uniform — variable heights, masonry, horizontal virtualisation — and not
 * before (invariant 12).
 *
 * Pure and DOM-free so it can be tested as arithmetic, which is what it is.
 */

export interface GridMetrics {
  /** How many cells there are in total, loaded or not. */
  readonly count: number;
  /** Width available for cells, in CSS pixels. */
  readonly viewportWidth: number;
  /** Height of the scrolling viewport, in CSS pixels. */
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly cellSize: number;
  readonly gap: number;
  /** Rows drawn beyond the viewport on each side, so a fast scroll is not blank. */
  readonly overscanRows: number;
}

export interface GridWindow {
  readonly columns: number;
  readonly rowHeight: number;
  /**
   * The full scrollable height, including the rows that are not instantiated.
   * This is what makes the scrollbar describe the library rather than the
   * portion of it currently in the DOM.
   */
  readonly totalHeight: number;
  /** First cell index to instantiate. */
  readonly firstIndex: number;
  /** One past the last cell index to instantiate. */
  readonly endIndex: number;
  /** Where to place the instantiated slice, so it lands under the scrollbar. */
  readonly offsetY: number;
}

export function gridWindow(metrics: GridMetrics): GridWindow {
  const { count, viewportWidth, viewportHeight, scrollTop, cellSize, gap, overscanRows } = metrics;

  // At least one column even in a viewport narrower than a cell: zero columns
  // divides by zero below and renders nothing at all, which looks like a
  // loading bug rather than a too-narrow window.
  const columns = Math.max(1, Math.floor((viewportWidth + gap) / (cellSize + gap)));
  const rowHeight = cellSize + gap;
  const rows = Math.ceil(count / columns);

  // The trailing gap after the final row is not scrollable space.
  const totalHeight = rows === 0 ? 0 : rows * rowHeight - gap;

  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const lastRow = Math.min(
    rows,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscanRows,
  );

  return {
    columns,
    rowHeight,
    totalHeight,
    firstIndex: firstRow * columns,
    endIndex: Math.min(count, Math.max(firstRow, lastRow) * columns),
    offsetY: firstRow * rowHeight,
  };
}
