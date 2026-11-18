/**
 * The bound on decoded-image memory.
 *
 * This is the budget that decides whether a reference board survives an
 * afternoon. A decoded bitmap costs `width x height x 4` bytes no matter how
 * many pixels it occupies on screen, so a 4000x3000 original is 48 MB decoded
 * and two hundred of them is a dead tab. Frame time was M01's question; bytes
 * are this one's.
 *
 * Deliberately not in `canvas-core`: `ImageBitmap`, `fetch` and
 * `AbortController` are DOM, and invariant 1 keeps the core free of it. Equally
 * not in the Konva package — a second renderer would want this unchanged.
 */

import {
  type AssetId,
  type CanvasItem,
  type DerivativeWidth,
  itemIntrinsicSize,
  pickDerivative,
  type VisibleItem,
} from '@visarium/canvas-core';
import { useEffect, useMemo, useReducer, useState } from 'react';

/** A decoded pixel is four bytes, in every browser, regardless of source format. */
const BYTES_PER_PIXEL = 4;

/**
 * Q7's hypothesis, not a measured value. It is a parameter rather than a
 * constant precisely so the benchmark can settle it — see
 * docs/development/OPEN_QUESTIONS.md#q7.
 */
export const DEFAULT_BITMAP_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * How long a tier UPGRADE waits for the camera to settle. Downgrades are not
 * debounced: they are cheap and they free memory.
 */
const UPGRADE_SETTLE_MS = 100;

export type BitmapTier = DerivativeWidth | 'original';

/** What a bitmap is of: an uploaded asset, or a local drop that has not landed yet. */
export type BitmapSource =
  | { readonly kind: 'asset'; readonly assetId: AssetId }
  | { readonly kind: 'preview'; readonly url: string };

/** `(assetId, derivativeWidth)`, as one string. Two tiers of one asset are two entries. */
export function bitmapKey(source: BitmapSource, tier: BitmapTier): string {
  return source.kind === 'asset' ? `${source.assetId}@${tier}` : `${source.url}@${tier}`;
}

/**
 * Set once by the share viewer (ADR-0026): images come from the link's own
 * routes, which serve only what is on the shared board and never the
 * original — the largest derivative stands in for it.
 */
let viaShareLink = false;
export function serveImagesFromShareLink(): void {
  viaShareLink = true;
}

export function bitmapUrl(source: BitmapSource, tier: BitmapTier): string {
  if (source.kind === 'preview') return source.url;
  if (viaShareLink) {
    return `/api/shared/assets/${source.assetId}/derivatives/${tier === 'original' ? 2048 : tier}`;
  }
  return tier === 'original'
    ? `/api/assets/${source.assetId}/content`
    : `/api/assets/${source.assetId}/derivatives/${tier}`;
}

export function bitmapSourceOf(item: CanvasItem): BitmapSource | undefined {
  if (item.content.kind === 'image') {
    return { kind: 'asset', assetId: item.content.asset.assetId };
  }
  return item.content.previewUrl ? { kind: 'preview', url: item.content.previewUrl } : undefined;
}

/** The tier this item would render at, given the zoom tiers are being chosen for. */
export function tierFor(item: CanvasItem, zoom: number): BitmapTier {
  // The WHOLE original's width on screen, not the visible box's: a crop shows a
  // part of the bitmap at full size, so a tenth-wide crop needs the tier a ten
  // times wider item would (ADR-0029).
  const screenWidth =
    (item.transform.width / item.crop.width) * zoom * (globalThis.devicePixelRatio ?? 1);
  const wanted = pickDerivative(screenWidth);
  // A tier wider than the image itself does not exist on the server, so asking
  // for it is a 404 rather than a bigger picture.
  const intrinsic = itemIntrinsicSize(item).width;
  return wanted !== 'original' && wanted >= intrinsic ? 'original' : wanted;
}

interface Entry {
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
}

interface Pending {
  readonly controller: AbortController;
}

export interface BitmapCacheOptions {
  readonly budgetBytes?: number;
  /** Called when a bitmap lands, so the surface can draw it. */
  readonly onLoad?: () => void;
  /** Injected in tests; the platform's `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; the platform's `createImageBitmap` otherwise. */
  readonly decodeImpl?: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
}

export class BitmapCache {
  /** Insertion order IS the LRU order: a hit re-inserts at the end. */
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Map<string, Pending>();
  #pinned: ReadonlySet<string> = new Set();
  /**
   * Evicted bitmaps waiting to be closed.
   *
   * They cannot be closed the moment they leave the map. The frame on screen
   * was drawn from the previous render, and a Konva node still holds the
   * bitmap until React renders again — closing it there produces
   * "drawImage: the image source is detached" and a blank item. So the pixels
   * are released one {@link pin} later, by which time a frame has been drawn
   * without them.
   */
  #closing: ImageBitmap[] = [];
  #bytes = 0;
  #failed = 0;

  readonly #budget: number;
  readonly #onLoad: () => void;
  readonly #fetch: typeof fetch;
  readonly #decode: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

  constructor(options: BitmapCacheOptions = {}) {
    this.#budget = options.budgetBytes ?? DEFAULT_BITMAP_BUDGET_BYTES;
    this.#onLoad = options.onLoad ?? (() => {});
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Bound, because `createImageBitmap` is a method on the global object and
    // calling it detached throws "Illegal invocation" — which the catch below
    // would swallow, leaving a canvas that quietly never draws an image.
    this.#decode = options.decodeImpl ?? globalThis.createImageBitmap.bind(globalThis);
  }

  /** Decoded bytes currently held. What Q7 is about. */
  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get inflight(): number {
    return this.#inflight.size;
  }

  /**
   * Requests that fetched or decoded and did not produce a bitmap.
   *
   * Reported rather than only logged: a cache that fails every decode looks
   * exactly like a cache nobody asked anything of, and that is how "no image
   * ever renders" hides for an afternoon.
   */
  get failed(): number {
    return this.#failed;
  }

  /** The bitmap for this key, if it is here. Counts as a use. */
  get(key: string): ImageBitmap | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    // Re-insert so iteration order stays least-recently-used first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.bitmap;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Start fetching this key unless it is already here or already coming.
   *
   * One promise per key is the whole point: panning back and forth over the same
   * region asks for the same bitmap repeatedly, and each duplicate would be a
   * request, a decode, and a second copy of the same pixels.
   */
  request(
    key: string,
    url: string,
    options: { resizeWidth?: number | undefined; low?: boolean | undefined } = {},
  ): Promise<void> {
    if (this.#entries.has(key) || this.#inflight.has(key)) return Promise.resolve();

    const controller = new AbortController();
    this.#inflight.set(key, { controller });

    return (async () => {
      try {
        const response = await this.#fetch(url, {
          signal: controller.signal,
          // Prefetch must not compete with what is on screen right now.
          priority: options.low ? 'low' : 'auto',
        } as RequestInit);
        if (!response.ok) throw new Error(`${response.status} for ${url}`);

        const blob = await response.blob();
        const bitmap = await this.#decode(
          blob,
          options.resizeWidth
            ? { resizeWidth: options.resizeWidth, resizeQuality: 'high' }
            : undefined,
        );

        if (controller.signal.aborted) {
          // The camera left while this was decoding. Keeping it would spend the
          // budget on a region nobody is looking at.
          bitmap.close();
          return;
        }
        this.#store(key, bitmap);
        this.#onLoad();
      } catch {
        // Aborted, offline, or a tier that is not there. A later frame asks again;
        // the item stays a placeholder until then, which is what it is for.
        if (!controller.signal.aborted) this.#failed += 1;
      } finally {
        this.#inflight.delete(key);
      }
    })();
  }

  /**
   * Re-key everything held for one source onto another.
   *
   * A dropped image is decoded locally before it is uploaded. When the upload
   * lands, the item's content changes from a local preview to an asset — and
   * without this the already-decoded pixels would be dropped and re-fetched
   * from the server, flashing a placeholder over an image the user is looking
   * at. The bytes are the same bytes.
   */
  adopt(fromSource: string, toSource: string): void {
    for (const [key, entry] of [...this.#entries]) {
      if (!key.startsWith(`${fromSource}@`)) continue;
      this.#entries.delete(key);
      this.#entries.set(`${toSource}@${key.slice(fromSource.length + 1)}`, entry);
    }
  }

  /**
   * Entries that must survive eviction: everything currently being drawn.
   *
   * Called once per frame from the surface, after render — which is what makes
   * it the right moment to release what the previous frame gave up.
   */
  pin(keys: ReadonlySet<string>): void {
    this.#releaseEvicted();
    this.#pinned = keys;
    this.#evict();
  }

  /** Cancel anything in flight whose key is no longer wanted. */
  abortOutside(keep: ReadonlySet<string>): void {
    for (const [key, pending] of this.#inflight) {
      if (keep.has(key)) continue;
      pending.controller.abort();
      this.#inflight.delete(key);
    }
  }

  dispose(): void {
    for (const pending of this.#inflight.values()) pending.controller.abort();
    this.#inflight.clear();
    this.#releaseEvicted();
    for (const entry of this.#entries.values()) entry.bitmap.close();
    this.#entries.clear();
    this.#bytes = 0;
    this.#pinned = new Set();
  }

  #store(key: string, bitmap: ImageBitmap): void {
    const bytes = bitmap.width * bitmap.height * BYTES_PER_PIXEL;
    this.#entries.set(key, { bitmap, bytes });
    this.#bytes += bytes;
    this.#evict();
  }

  /**
   * Least-recently-used first, skipping anything pinned, calling `close()` on
   * the way out.
   *
   * `close()` is not optional. A budget that counts bytes it never releases is a
   * counter, not a cache: the pixels stay with the tab until it dies.
   */
  #evict(): void {
    if (this.#bytes <= this.#budget) return;
    for (const [key, entry] of this.#entries) {
      if (this.#bytes <= this.#budget) return;
      if (this.#pinned.has(key)) continue;
      this.#closing.push(entry.bitmap);
      this.#entries.delete(key);
      this.#bytes -= entry.bytes;
    }
    // Falling through means the active set alone exceeds the budget. Exceeding
    // it beats evicting something on screen; the stats readout reports `bytes`.
  }

  /** Release the previous cycle's evictions. See {@link #closing}. */
  #releaseEvicted(): void {
    for (const bitmap of this.#closing) bitmap.close();
    this.#closing.length = 0;
  }
}

/**
 * The zoom that tier selection uses, which trails the camera upward and follows
 * it downward immediately.
 *
 * `min(live, settled)` is the whole debounce: zooming in raises `live` while
 * `settled` lags, so the tier does not improve mid-gesture; zooming out lowers
 * `live` at once, so it degrades immediately and frees memory.
 */
export function useTierZoom(zoom: number, settleMs = UPGRADE_SETTLE_MS): number {
  const [settled, setSettled] = useState(zoom);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(zoom), settleMs);
    return () => clearTimeout(timer);
  }, [zoom, settleMs]);
  return Math.min(zoom, settled);
}

/**
 * Wires the cache to a frame: pin what is drawn, fetch what is missing, abort
 * what has left.
 *
 * ponytail: the sync runs every frame, which is a few hundred key strings per
 * frame at the node ceiling. If that ever shows up in a profile, throttle the
 * prefetch half and keep the pin half per-frame — eviction is the part that
 * must not run on stale information.
 */
export function useBitmaps(
  visible: readonly VisibleItem[],
  zoom: number,
  budgetBytes: number = DEFAULT_BITMAP_BUDGET_BYTES,
) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const cache = useMemo(
    () => new BitmapCache({ budgetBytes, onLoad: () => redraw() }),
    [budgetBytes],
  );
  useEffect(() => () => cache.dispose(), [cache]);

  const tierZoom = useTierZoom(zoom);

  useEffect(() => {
    const wanted: { key: string; url: string; resizeWidth?: number | undefined }[] = [];
    for (const { item } of visible) {
      const source = bitmapSourceOf(item);
      if (!source) continue;
      const tier = tierFor(item, tierZoom);
      wanted.push({
        key: bitmapKey(source, tier),
        url: bitmapUrl(source, tier),
        // A local drop has no server-side ladder, so its tiers are cut here.
        resizeWidth: source.kind === 'preview' && tier !== 'original' ? tier : undefined,
      });
    }

    // Pin before requesting: eviction must never run against a stale idea of
    // what is on screen, and a request that lands early would do exactly that.
    const keys = new Set(wanted.map((entry) => entry.key));
    cache.pin(keys);
    cache.abortOutside(keys);
    for (const entry of wanted) {
      cache.request(entry.key, entry.url, { resizeWidth: entry.resizeWidth });
    }
  }, [visible, tierZoom, cache]);

  return {
    cache,
    /**
     * The best bitmap available for this item right now: its own tier, or a
     * larger one already in memory rather than nothing. Drawing a 1024 px
     * bitmap into a 512 px box for one frame beats drawing a grey rectangle.
     */
    bitmapFor(item: CanvasItem): ImageBitmap | undefined {
      const source = bitmapSourceOf(item);
      if (!source) return undefined;

      const tier = tierFor(item, tierZoom);
      const exact = cache.get(bitmapKey(source, tier));
      if (exact) return exact;

      const wider: BitmapTier[] = [
        ...([2048, 1024, 512, 256, 64] as const).filter((w) => tier === 'original' || w > tier),
        'original',
      ];
      for (const candidate of wider) {
        const interim = cache.get(bitmapKey(source, candidate));
        if (interim) return interim;
      }
      return undefined;
    },
  };
}
