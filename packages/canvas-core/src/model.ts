/**
 * The logical contents of a canvas.
 *
 * A {@link CanvasItem} is the placement of something on a board. An
 * {@link AssetRef} is the identity of the underlying stored file. They are
 * deliberately separate: one asset may appear on many boards, many times, or
 * nowhere, and its file is never duplicated to make that work.
 */

import type { Transform } from './geometry';
import type { AssetId, GroupId, ItemId } from './ids';

/**
 * A reference to a stored asset.
 *
 * `intrinsicWidth`/`intrinsicHeight` are the ORIGINAL pixel dimensions. They let
 * the canvas lay out and size an item before a single byte of image data has
 * been decoded, which is what makes a dropped image appear instantly.
 *
 * Note what is absent: no path, no URL, no storage key. See invariant 3.
 */
export interface AssetRef {
  readonly assetId: AssetId;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

export type CanvasItemContent =
  | { readonly kind: 'image'; readonly asset: AssetRef }
  /** A local, not-yet-uploaded drop. Carries no asset id until the upload resolves. */
  | {
      readonly kind: 'placeholder';
      readonly intrinsicWidth: number;
      readonly intrinsicHeight: number;
      /** Object URL or data URL for optimistic display. Never persisted. */
      readonly previewUrl?: string;
    };

/**
 * What an item looks like, as opposed to where it is or what it shows.
 *
 * Opacity and flip are one value because they share the fact that decides how
 * every layer treats them: neither changes an item's bounds, so neither touches
 * the spatial index. A flip is a boolean here and NEVER a negative width — the
 * schema's `CHECK (width > 0)`, `transformBounds` and every size comparison in
 * the codebase all assume a positive size, and Konva's negative scale is a
 * rendering trick that stays on the renderer's side of the boundary.
 */
export interface Appearance {
  /** 0 … 1. Bounded at every boundary, including the schema. */
  readonly opacity: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/**
 * The one default.
 *
 * `appearance` is required on {@link CanvasItem} rather than optional precisely
 * so this constant is the only place the default is written. An optional field
 * would mean a `?? 1` at every read, and every one of those is a place the
 * default can drift.
 */
export const DEFAULT_APPEARANCE: Appearance = { opacity: 1, flipX: false, flipY: false };

/**
 * The part of the original an item shows, as fractions of the original's width
 * and height, in source orientation (before any flip). ADR-0029.
 *
 * The transform stays the VISIBLE box, so nothing that only needs bounds ever
 * learns about crop; the image's scale is derived, never stored.
 */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The one default, for the same reason as {@link DEFAULT_APPEARANCE}. */
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

export function isFullCrop(crop: Crop): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

export interface CanvasItem {
  readonly id: ItemId;
  readonly transform: Transform;
  /** Sparse ordering key. Items are drawn low-to-high. */
  readonly z: number;
  readonly groupId?: GroupId;
  readonly content: CanvasItemContent;
  readonly appearance: Appearance;
  readonly crop: Crop;
}

export interface CanvasGroup {
  readonly id: GroupId;
  readonly label?: string;
  /**
   * Whether the renderer draws the derived annotation outline around the
   * members. Presentation state, not identity: absent means unframed, which
   * keeps every group written before the flag existed exactly as it was. The
   * contour itself is never stored — it is recomputed from member bounds.
   */
  readonly frame?: boolean;
  /** Groups do not nest in v1. See OPEN_QUESTIONS. */
  readonly memberIds: readonly ItemId[];
}

export function itemIntrinsicSize(item: CanvasItem): { width: number; height: number } {
  return item.content.kind === 'image'
    ? { width: item.content.asset.intrinsicWidth, height: item.content.asset.intrinsicHeight }
    : { width: item.content.intrinsicWidth, height: item.content.intrinsicHeight };
}
