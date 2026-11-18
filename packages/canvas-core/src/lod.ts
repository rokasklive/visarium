/**
 * Level of detail.
 *
 * LOD is renderer-independent on purpose: it is a function from "how big will
 * this be on screen" to "how much of it is worth paying for". The renderer obeys
 * the answer; it does not compute it.
 *
 * Two independent axes:
 *   - {@link ItemLod}   how elaborately an item is drawn at all
 *   - {@link pickDerivative}  which stored image size to fetch
 *
 * Thresholds below are starting hypotheses, not measured results. They are
 * expected to move once M01's torture board exists — see OPEN_QUESTIONS.
 */

import type { Transform } from './geometry';

export const ItemLod = {
  /** Full-resolution derivative, interactive, hit-testable. */
  FULL: 'full',
  /** Large but not pixel-critical. */
  PREVIEW: 'preview',
  /** Small on screen; a thumbnail is indistinguishable from the original. */
  THUMBNAIL: 'thumbnail',
  /** A few pixels. Colour blob territory. */
  MICRO: 'micro',
  /** Too small to mean anything alone; the renderer should draw its group instead. */
  AGGREGATE: 'aggregate',
  /** Outside the preload region. Not instantiated at all. */
  HIDDEN: 'hidden',
} as const;

export type ItemLod = (typeof ItemLod)[keyof typeof ItemLod];

/** Derivative widths generated for every asset, largest first. `0` means the original. */
export const DERIVATIVE_WIDTHS = [2048, 1024, 512, 256, 64] as const;
export type DerivativeWidth = (typeof DERIVATIVE_WIDTHS)[number];

export interface LodThresholds {
  /** Screen px below which an item is aggregated away. */
  readonly aggregateBelow: number;
  /** Screen px below which an item is a colour blob. */
  readonly microBelow: number;
  /** Screen px below which a thumbnail suffices. */
  readonly thumbnailBelow: number;
  /** Screen px below which a preview derivative suffices. */
  readonly previewBelow: number;
}

export const DEFAULT_LOD_THRESHOLDS: LodThresholds = {
  aggregateBelow: 4,
  microBelow: 24,
  thumbnailBelow: 128,
  previewBelow: 768,
};

/** Longest edge of the item in screen pixels at the given zoom. */
export function projectedSize(transform: Transform, zoom: number): number {
  return Math.max(transform.width, transform.height) * zoom;
}

export function resolveLod(
  transform: Transform,
  zoom: number,
  thresholds: LodThresholds = DEFAULT_LOD_THRESHOLDS,
): ItemLod {
  const size = projectedSize(transform, zoom);
  if (size < thresholds.aggregateBelow) return ItemLod.AGGREGATE;
  if (size < thresholds.microBelow) return ItemLod.MICRO;
  if (size < thresholds.thumbnailBelow) return ItemLod.THUMBNAIL;
  if (size < thresholds.previewBelow) return ItemLod.PREVIEW;
  return ItemLod.FULL;
}

/**
 * Smallest stored derivative that still covers `screenWidth` physical pixels.
 * Returns `'original'` when even the largest derivative would upscale visibly.
 *
 * `devicePixelRatio` is the caller's business — pass physical pixels.
 */
export function pickDerivative(screenWidth: number): DerivativeWidth | 'original' {
  let chosen: DerivativeWidth | 'original' = 'original';
  for (const width of DERIVATIVE_WIDTHS) {
    if (width >= screenWidth) chosen = width;
  }
  return chosen;
}
