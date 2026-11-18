import {
  asAssetId,
  asItemId,
  type CanvasItem,
  type Crop,
  DEFAULT_APPEARANCE,
  FULL_CROP,
} from '@visarium/canvas-core';
import { describe, expect, it, vi } from 'vitest';
import { BitmapCache, bitmapKey, bitmapUrl, tierFor } from './bitmap-cache';

const MB = 1024 * 1024;

/**
 * A decoded bitmap that can say whether it was closed.
 *
 * `close()` is the assertion that matters in most of this file: a budget
 * measured in bytes that never releases any is a counter, not a cache.
 */
function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

/** One megapixel: 1024 x 256 x 4 bytes = 1 MB decoded. */
function oneMegabyte() {
  return fakeBitmap(1024, 256);
}

function cacheOf(
  bitmaps: () => ImageBitmap,
  options: { budgetBytes?: number; onLoad?: () => void } = {},
) {
  const fetched: string[] = [];
  const decoded = { count: 0 };
  const cache = new BitmapCache({
    budgetBytes: options.budgetBytes ?? 64 * MB,
    onLoad: options.onLoad ?? (() => {}),
    fetchImpl: (async (url: string) => {
      fetched.push(String(url));
      return { ok: true, blob: async () => new Blob() } as unknown as Response;
    }) as unknown as typeof fetch,
    decodeImpl: async () => {
      decoded.count += 1;
      return bitmaps();
    },
  });
  return { cache, fetched, decoded };
}

describe('keys and urls', () => {
  it('makes one entry per asset and tier', () => {
    const source = { kind: 'asset', assetId: asAssetId('a1') } as const;
    expect(bitmapKey(source, 512)).not.toEqual(bitmapKey(source, 1024));
  });

  it('addresses a derivative by id and width, never by a storage path', () => {
    expect(bitmapUrl({ kind: 'asset', assetId: asAssetId('a1') }, 512)).toBe(
      '/api/assets/a1/derivatives/512',
    );
    expect(bitmapUrl({ kind: 'asset', assetId: asAssetId('a1') }, 'original')).toBe(
      '/api/assets/a1/content',
    );
  });

  it('uses the local url for a drop that has not uploaded yet', () => {
    expect(bitmapUrl({ kind: 'preview', url: 'blob:x' }, 256)).toBe('blob:x');
  });
});

describe('choosing a tier', () => {
  const image = (width: number, crop: Crop): CanvasItem => ({
    id: asItemId('i'),
    transform: { x: 0, y: 0, width, height: width, rotation: 0 },
    z: 0,
    content: {
      kind: 'image',
      asset: { assetId: asAssetId('a'), intrinsicWidth: 8000, intrinsicHeight: 8000 },
    },
    appearance: DEFAULT_APPEARANCE,
    crop,
  });

  it('picks for the whole original, so a tight crop stays sharp', () => {
    const tenth = { x: 0.45, y: 0.45, width: 0.1, height: 0.1 };
    expect(tierFor(image(100, tenth), 1)).toBe(tierFor(image(1000, FULL_CROP), 1));
    expect(tierFor(image(100, tenth), 1)).not.toBe(tierFor(image(100, FULL_CROP), 1));
  });
});

describe('the byte budget', () => {
  it('accounts a bitmap at four bytes a pixel', async () => {
    const { cache } = cacheOf(() => fakeBitmap(100, 50));
    await cache.request('k', '/u');

    expect(cache.bytes).toBe(100 * 50 * 4);
  });

  it('tells 200 thumbnails from 200 originals', async () => {
    const { cache } = cacheOf(() => fakeBitmap(64, 64), { budgetBytes: 100 * MB });
    await cache.request('small', '/small');
    const afterSmall = cache.bytes;

    const big = cacheOf(() => fakeBitmap(4000, 3000), { budgetBytes: 100 * MB });
    await big.cache.request('big', '/big');

    expect(afterSmall).toBe(64 * 64 * 4);
    expect(big.cache.bytes).toBe(4000 * 3000 * 4);
    expect(big.cache.size).toBe(afterSmall && 1);
  });

  it('evicts until it is back within budget, and closes what it drops', async () => {
    const closed: (ImageBitmap & { close: ReturnType<typeof vi.fn> })[] = [];
    const { cache } = cacheOf(
      () => {
        const bitmap = oneMegabyte();
        closed.push(bitmap);
        return bitmap;
      },
      { budgetBytes: 3 * MB },
    );

    for (const key of ['a', 'b', 'c', 'd', 'e']) await cache.request(key, `/${key}`);

    expect(cache.bytes).toBeLessThanOrEqual(3 * MB);
    expect(cache.size).toBe(3);

    // Evicted, but not yet closed: the frame on screen was drawn from the last
    // render and its Konva nodes still hold these bitmaps.
    expect(closed[0]?.close).not.toHaveBeenCalled();

    // The next frame's pin is what releases them.
    cache.pin(new Set());
    expect(closed[0]?.close).toHaveBeenCalled();
    expect(closed[1]?.close).toHaveBeenCalled();
    expect(closed[4]?.close).not.toHaveBeenCalled();
  });

  it('does not close a bitmap the current frame is still drawing', async () => {
    const drawn: (ImageBitmap & { close: ReturnType<typeof vi.fn> })[] = [];
    const { cache } = cacheOf(
      () => {
        const bitmap = oneMegabyte();
        drawn.push(bitmap);
        return bitmap;
      },
      { budgetBytes: 1 * MB },
    );

    await cache.request('old', '/old');
    await cache.request('new', '/new');

    // 'old' was evicted by 'new' landing. Closing it here would detach a bitmap
    // that the last painted frame still references — "the image source is
    // detached", and a blank item where a photograph was.
    expect(drawn[0]?.close).not.toHaveBeenCalled();
  });

  it('evicts least-recently-used, not least-recently-fetched', async () => {
    const { cache } = cacheOf(oneMegabyte, { budgetBytes: 2 * MB });
    await cache.request('a', '/a');
    await cache.request('b', '/b');

    cache.get('a'); // 'a' is now the most recently used
    await cache.request('c', '/c');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });
});

describe('pinning the active set', () => {
  it('never evicts something that is being drawn', async () => {
    const { cache } = cacheOf(oneMegabyte, { budgetBytes: 2 * MB });
    await cache.request('onscreen', '/onscreen');
    cache.pin(new Set(['onscreen']));

    for (const key of ['a', 'b', 'c', 'd']) await cache.request(key, `/${key}`);

    expect(cache.has('onscreen')).toBe(true);
  });

  it('keeps the tier being drawn when an item changes level of detail', async () => {
    const { cache } = cacheOf(oneMegabyte, { budgetBytes: 2 * MB });
    await cache.request('asset@512', '/512');
    cache.pin(new Set(['asset@512']));

    // Zooming in: the 1024 arrives while the 512 is still what is on screen.
    await cache.request('asset@1024', '/1024');
    await cache.request('other', '/other');

    expect(cache.has('asset@512')).toBe(true);
  });

  it('would rather exceed the budget than drop what is on screen', async () => {
    const { cache } = cacheOf(oneMegabyte, { budgetBytes: 1 * MB });
    // Pinned first, as the surface does it: eviction runs as bitmaps land.
    cache.pin(new Set(['a', 'b']));
    await cache.request('a', '/a');
    await cache.request('b', '/b');

    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeGreaterThan(1 * MB);
  });
});

describe('coalescing and cancellation', () => {
  it('fetches and decodes once however many callers ask', async () => {
    const { cache, fetched, decoded } = cacheOf(oneMegabyte);

    await Promise.all([
      cache.request('k', '/u'),
      cache.request('k', '/u'),
      cache.request('k', '/u'),
    ]);

    expect(fetched).toEqual(['/u']);
    expect(decoded.count).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('does not re-fetch something it already holds', async () => {
    const { cache, fetched } = cacheOf(oneMegabyte);
    await cache.request('k', '/u');
    await cache.request('k', '/u');

    expect(fetched).toEqual(['/u']);
  });

  it('aborts requests for regions that have left the preload ring', async () => {
    let abortedUrl: string | undefined;
    const cache = new BitmapCache({
      fetchImpl: ((url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            abortedUrl = String(url);
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch,
      decodeImpl: async () => oneMegabyte(),
    });

    const pending = cache.request('gone', '/gone');
    expect(cache.inflight).toBe(1);

    cache.abortOutside(new Set(['still-wanted']));
    await pending;

    expect(abortedUrl).toBe('/gone');
    expect(cache.inflight).toBe(0);
    expect(cache.has('gone')).toBe(false);
  });

  it('closes a bitmap that finishes decoding after its request was abandoned', async () => {
    const bitmap = oneMegabyte();
    let release: (() => void) | undefined;
    const cache = new BitmapCache({
      fetchImpl: (async () =>
        ({
          ok: true,
          blob: async () => new Blob(),
        }) as unknown as Response) as unknown as typeof fetch,
      decodeImpl: () =>
        new Promise((resolve) => {
          release = () => resolve(bitmap);
        }),
    });

    const pending = cache.request('slow', '/slow');
    // Let the fetch resolve so the decode has actually started.
    await vi.waitFor(() => expect(release).toBeDefined());

    cache.abortOutside(new Set());
    release?.();
    await pending;

    expect(bitmap.close).toHaveBeenCalled();
    expect(cache.bytes).toBe(0);
  });

  it('leaves nothing decoded when a fetch fails', async () => {
    const cache = new BitmapCache({
      fetchImpl: (async () =>
        ({ ok: false, status: 404 }) as unknown as Response) as unknown as typeof fetch,
      decodeImpl: async () => oneMegabyte(),
    });

    await cache.request('missing', '/missing');

    expect(cache.size).toBe(0);
    expect(cache.inflight).toBe(0);
  });
});

describe('adopting a preview once its upload lands', () => {
  it('keeps the decoded pixels instead of re-fetching what was just sent', async () => {
    const { cache, fetched } = cacheOf(oneMegabyte);
    await cache.request('blob:local@512', '/blob');
    const before = cache.bytes;

    cache.adopt('blob:local', 'asset-1');

    expect(cache.has('asset-1@512')).toBe(true);
    expect(cache.has('blob:local@512')).toBe(false);
    expect(cache.bytes).toBe(before);
    expect(fetched).toEqual(['/blob']);
  });

  it('moves every tier it holds for that source', async () => {
    const { cache } = cacheOf(oneMegabyte);
    await cache.request('blob:local@512', '/a');
    await cache.request('blob:local@256', '/b');
    await cache.request('other@512', '/c');

    cache.adopt('blob:local', 'asset-1');

    expect(cache.has('asset-1@512')).toBe(true);
    expect(cache.has('asset-1@256')).toBe(true);
    expect(cache.has('other@512')).toBe(true);
  });
});

describe('disposal', () => {
  it('closes everything it holds', async () => {
    const bitmaps: (ImageBitmap & { close: ReturnType<typeof vi.fn> })[] = [];
    const { cache } = cacheOf(() => {
      const bitmap = oneMegabyte();
      bitmaps.push(bitmap);
      return bitmap;
    });

    await cache.request('a', '/a');
    await cache.request('b', '/b');
    cache.dispose();

    expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });
});

describe('notification', () => {
  it('tells the surface to draw when a bitmap lands', async () => {
    const onLoad = vi.fn();
    const { cache } = cacheOf(oneMegabyte, { onLoad });
    await cache.request('k', '/u');

    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});
