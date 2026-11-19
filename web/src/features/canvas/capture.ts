/**
 * Drop and paste: a file becoming an item on the board.
 *
 * The item exists before the network is consulted. That is not an optimisation,
 * it is the product — north star 3 says nothing is ever saved, so a reference
 * that has to wait for a round trip to appear has already failed.
 */

import type {
  AssetId,
  CanvasItem,
  CanvasOperationBody,
  ItemId,
  Rect,
  Transform,
} from '@visarium/canvas-core';
import { newItemId } from '@visarium/canvas-core';

/** Images only. A dropped PDF is not a reference the canvas can draw. */
export function imageFilesFrom(source: DataTransfer | null): File[] {
  if (!source) return [];
  return [...source.files].filter((file) => file.type.startsWith('image/'));
}

/**
 * The drag payload the library writes and the canvas reads.
 *
 * A private MIME type rather than `text/uri-list`: the canvas already accepts
 * dragged files, and a URL list would make its drop handler ambiguous with an
 * image dragged in from a browser tab.
 *
 * M09 added the second type this comment predicted, and it turned out to be two:
 * real `File`s for everything outside Visarium, and `text/plain` content URLs
 * for everything that takes neither. This one still wins. Every reader inside
 * Visarium checks it FIRST, because a transfer Visarium wrote now carries all
 * three and a reader that looked at files first would re-upload bytes the
 * instance already has. See {@link writeAssetTransfer} for the writer.
 */
export const ASSET_DRAG_TYPE = 'application/x-visarium-assets';

/** An asset the library already knows the size of, ready to become an item. */
export interface DraggedAsset {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType?: string | undefined;
}

/** Assets in a drag, or none — a drag carrying files instead is not this. */
export function draggedAssetsFrom(source: DataTransfer | null): DraggedAsset[] {
  const raw = source?.getData(ASSET_DRAG_TYPE);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DraggedAsset =>
        typeof entry?.assetId === 'string' && entry.width > 0 && entry.height > 0,
    );
  } catch {
    // Something else claimed our type. Not ours, so not our drop.
    return [];
  }
}

/**
 * Where an asset's original bytes live. One place, so the writer below and the
 * reader below that cannot drift apart.
 */
export function contentUrl(assetId: string): string {
  return `/api/assets/${assetId}/content`;
}

/**
 * One absolute content URL per asset, one per line.
 *
 * The `text/plain` payload of both outward gestures — absolute, because the far
 * side of a drag or a paste is somewhere with no notion of this page's base.
 */
export function contentUrlList(assets: readonly { readonly assetId: string }[]): string {
  return assets.map((asset) => new URL(contentUrl(asset.assetId), location.href).href).join('\n');
}

/** The same route, recognised. The id is a UUID and the path has nothing after it. */
const CONTENT_ROUTE = /^\/api\/assets\/([0-9a-f-]{36})\/content$/i;

/**
 * Which board an outward drag came from.
 *
 * Written only by {@link writeAssetTransfer}; a library drag does not set it.
 * It exists because take out sits a few pixels above the selection — which means
 * it sits over the CANVAS — so the default resting place of any drag that does
 * not leave the window is the board it started on. Without this, letting go of
 * an abandoned export silently duplicates the whole selection.
 *
 * A separate type rather than a field inside the asset payload: the library has
 * written that payload as a bare array since M04, and giving it two shapes to
 * parse is how a reader starts guessing.
 */
export const ASSET_ORIGIN_TYPE = 'application/x-visarium-origin';

/** A selected image, reduced to what an outward transfer has to say about it. */
export interface OutwardAsset extends DraggedAsset {
  /** The item's stacking order. Files are written in it, bottom to top. */
  readonly z: number;
}

/**
 * What a selection can hand to the operating system: distinct assets, bottom of
 * the stack first.
 *
 * A placeholder is excluded here and therefore from all three payloads, for the
 * reason `duplicateSelection` already gives: its content has no asset id, so
 * there is nothing stored to hand over. The same asset placed twice is one
 * entry, because two identical files with one name is the drop target's problem
 * and not a payload worth sending.
 */
export function outwardAssets(
  doc: { item: (id: ItemId) => CanvasItem | undefined },
  ids: Iterable<ItemId>,
): OutwardAsset[] {
  const distinct = new Map<string, OutwardAsset>();
  for (const id of ids) {
    const item = doc.item(id);
    if (item?.content.kind !== 'image') continue;
    const { assetId, intrinsicWidth, intrinsicHeight } = item.content.asset;
    const kept = distinct.get(assetId);
    if (kept === undefined || item.z < kept.z) {
      distinct.set(assetId, {
        assetId,
        width: intrinsicWidth,
        height: intrinsicHeight,
        z: item.z,
      });
    }
  }
  return [...distinct.values()].sort((a, b) => a.z - b.z);
}

/**
 * A selection leaving the browser, as everything that might read it.
 *
 * Three payloads on one transfer, in the order a reader should prefer them:
 * the private type for Visarium's own handlers, real files for the operating
 * system, and content URLs for anything that takes neither. The files are the
 * milestone's guarantee — the ORIGINAL bytes, never a derivative and never a
 * re-encode — so an asset whose original has not been fetched yet contributes
 * no file rather than a substitute. The caller says so; this does not invent one.
 */
export function writeAssetTransfer(
  transfer: DataTransfer,
  assets: readonly OutwardAsset[],
  originals: ReadonlyMap<string, File>,
  origin: string,
): void {
  if (assets.length === 0) return;
  const payload: DraggedAsset[] = assets.map(({ assetId, width, height }) => ({
    assetId,
    width,
    height,
  }));
  transfer.setData(ASSET_DRAG_TYPE, JSON.stringify(payload));
  transfer.setData(ASSET_ORIGIN_TYPE, origin);
  transfer.setData('text/plain', contentUrlList(assets));
  for (const asset of assets) {
    const file = originals.get(asset.assetId);
    if (file) transfer.items.add(file);
  }
  transfer.effectAllowed = 'copy';
}

/**
 * The reader for what {@link writeAssetTransfer} put in `text/plain` — the only
 * payload a clipboard write can carry back, since a page may not put a private
 * MIME type on the system clipboard.
 *
 * All or nothing. One line that is not this instance's own content route means
 * the text was not written by us, and a paragraph that happens to mention a URL
 * is a paragraph. The origin is checked too: the same path on another host is
 * another instance's asset, whose id means nothing here.
 */
export function assetUrlsFrom(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    let url: URL;
    try {
      url = new URL(candidate, location.href);
    } catch {
      return [];
    }
    if (url.origin !== location.origin) return [];
    const id = CONTENT_ROUTE.exec(url.pathname)?.[1];
    if (id === undefined) return [];
    ids.push(id);
  }
  return ids;
}

/**
 * What a drop or a paste actually is — the ordering rule, stated once.
 *
 * **A payload Visarium wrote beats a payload the browser synthesised.** The
 * canvas drop handler has had that rule since M04 for drags; M09 made it
 * load-bearing everywhere, because Visarium's own drags and clipboard writes now
 * carry files and URL text beside the private type. A reader that looked at
 * files first would re-upload bytes this instance already has, and a PNG
 * fallback would enter the library as a genuinely new asset.
 *
 * So both call sites read this and neither reimplements the order. A transfer
 * with no Visarium payload is an arrival of new bytes and nothing about it has
 * changed since M02.
 */
export type Arrival =
  /**
   * Our own drag: assets, with the sizes the source already knew, and the board
   * it left — absent for a library drag, which came from no board.
   */
  | { readonly kind: 'assets'; readonly assets: DraggedAsset[]; readonly origin: string }
  /** Our own clipboard: asset ids only, since a page may not put a private type on it. */
  | { readonly kind: 'ids'; readonly assetIds: string[] }
  /** Somebody else's: bytes this instance has never seen. */
  | { readonly kind: 'files'; readonly files: File[] }
  | { readonly kind: 'nothing' };

export function readTransfer(source: DataTransfer | null | undefined): Arrival {
  const assets = draggedAssetsFrom(source ?? null);
  if (assets.length > 0) {
    return { kind: 'assets', assets, origin: source?.getData(ASSET_ORIGIN_TYPE) ?? '' };
  }
  const assetIds = assetUrlsFrom(source?.getData('text/plain'));
  if (assetIds.length > 0) return { kind: 'ids', assetIds };
  const files = imageFilesFrom(source ?? null);
  if (files.length > 0) return { kind: 'files', files };
  return { kind: 'nothing' };
}

export interface Capture {
  readonly itemId: ItemId;
  readonly file: File;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Read the file's intrinsic size locally, so the item is the right shape from
 * the first frame rather than snapping when the server answers.
 *
 * `createImageBitmap` decodes off the main thread, which is why it is used here
 * instead of an `<img>` and a load event.
 */
export async function readCapture(file: File): Promise<Capture | undefined> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return {
      itemId: newItemId(),
      file,
      previewUrl: URL.createObjectURL(file),
      width: bitmap.width,
      height: bitmap.height,
    };
  } catch {
    // Not something the browser can decode. The server would refuse it too.
    return undefined;
  } finally {
    // The preview is fetched from the object URL by the bitmap cache, at the
    // tier it will actually be drawn at. This full-size decode was for the
    // dimensions only.
    bitmap?.close();
  }
}

/**
 * The fraction of the visible world rectangle's shorter edge a placed item may
 * cover. A guess, like every other canvas constant started as — a parameter
 * rather than a literal so it can be measured instead of argued about.
 */
export const PLACEMENT_FRACTION = 0.4;

/**
 * Where placed items land: centred on the drop point, cascading so a multi-file
 * drop does not become one stack nobody can separate.
 *
 * Size is intrinsic pixels scaled DOWN to fit the fraction above — never up,
 * because enlarging a 64px icon is the interface deciding it should be blurry.
 * Reading the visible rect rather than a fixed world size is what makes a
 * photograph land large enough to see when zoomed out and small enough to fit
 * when zoomed into a corner.
 */
export function placeCapture(
  intrinsic: { readonly width: number; readonly height: number },
  at: { x: number; y: number },
  index: number,
  world: Rect,
  fraction = PLACEMENT_FRACTION,
): Transform {
  const offset = index * 24;
  const scale = placementScale(intrinsic, world, fraction);
  return {
    x: at.x + offset,
    y: at.y + offset,
    width: intrinsic.width * scale,
    height: intrinsic.height * scale,
    rotation: 0,
  };
}

function placementScale(
  intrinsic: { readonly width: number; readonly height: number },
  world: Rect,
  fraction: number,
): number {
  const shorterEdge = Math.min(world.maxX - world.minX, world.maxY - world.minY);
  const longerSide = Math.max(intrinsic.width, intrinsic.height);
  // A viewport with no area yet — first frame, hidden tab — has nothing to size
  // against, so the intrinsic size stands rather than collapsing to zero.
  if (!(shorterEdge > 0) || !(longerSide > 0)) return 1;
  return Math.min(1, (fraction * shorterEdge) / longerSide);
}

export function createItem(capture: Capture, transform: Transform, z: number): CanvasOperationBody {
  return {
    type: 'item.create',
    itemId: capture.itemId,
    transform,
    z,
    content: {
      kind: 'placeholder',
      intrinsicWidth: capture.width,
      intrinsicHeight: capture.height,
      previewUrl: capture.previewUrl,
    },
  };
}

/**
 * Placing an asset that is already in the library — the sibling of
 * {@link createItem} and a shorter path than a drop.
 *
 * The library page already carries the asset id and its intrinsic size, which
 * is exactly and only what image content needs. So there is no placeholder, no
 * object URL and no upload: the item is complete the instant it exists.
 */
export function createPlacement(
  asset: {
    readonly assetId: AssetId;
    readonly width: number;
    readonly height: number;
    readonly mimeType?: string | undefined;
  },
  transform: Transform,
  z: number,
): CanvasOperationBody {
  return {
    type: 'item.create',
    itemId: newItemId(),
    transform,
    z,
    content: {
      kind: 'image',
      asset: {
        assetId: asset.assetId,
        intrinsicWidth: asset.width,
        intrinsicHeight: asset.height,
        mimeType: asset.mimeType,
      },
    },
  };
}
