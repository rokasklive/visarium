import { afterEach, describe, expect, it, vi } from 'vitest';
import { copySelection, dragNotice, fetchOriginal, NOTICES, warmOriginals } from './interchange';

/**
 * The half of the milestone the platform decides.
 *
 * What is worth pinning here is every branch of that decision — the type
 * `ClipboardItem` will accept, the re-encode that must not change the
 * resolution, and the refusal that must not throw past the caller — because none
 * of it can be observed in a headless browser and all of it can be got wrong
 * silently.
 */

const asset = (assetId: string) => ({ assetId, width: 100, height: 80, z: 0 });

/** Everything happy-dom does not have: a clipboard, an item, a decoder, a canvas. */
function stubPlatform({
  supports,
  write = vi.fn(async () => {}),
  decoded = { width: 4000, height: 3000 },
}: {
  supports?: ((type: string) => boolean) | undefined;
  write?: ReturnType<typeof vi.fn>;
  decoded?: { width: number; height: number };
} = {}) {
  const written: Record<string, unknown>[] = [];
  class FakeClipboardItem {
    static supports = supports;
    constructor(readonly items: Record<string, unknown>) {
      written.push(items);
    }
  }
  if (supports === undefined) Reflect.deleteProperty(FakeClipboardItem, 'supports');
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('navigator', { clipboard: { write } });

  const encoded: { width: number; height: number }[] = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ ...decoded, close: vi.fn() })),
  );
  class FakeOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      encoded.push({ width, height });
    }
    getContext() {
      return { drawImage: vi.fn() };
    }
    async convertToBlob({ type }: { type: string }) {
      return new Blob(['png'], { type });
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

  return { written, write, encoded };
}

/** Resolve the promise the write was handed, which is where the format lands. */
async function carried(item: Record<string, unknown>, type: string): Promise<Blob> {
  return (await item[type]) as Blob;
}

afterEach(() => vi.unstubAllGlobals());

describe('choosing what the clipboard can carry', () => {
  it('prefers the original type when the browser says it accepts it', async () => {
    const { written } = stubPlatform({ supports: (type) => type === 'image/jpeg' });
    const original = new File(['bytes'], 'ref.jpg', { type: 'image/jpeg' });

    const outcome = await copySelection([asset('a1')], new Map([['a1', original]]));

    expect(outcome).toBe('original');
    expect(Object.keys(written[0] as object)).toContain('image/jpeg');
  });

  it('falls back to PNG when the browser refuses the original type, and says so', async () => {
    const { written } = stubPlatform({ supports: () => false });
    const original = new File(['bytes'], 'ref.jpg', { type: 'image/jpeg' });

    const outcome = await copySelection([asset('a1')], new Map([['a1', original]]));

    expect(outcome).toBe('png');
    expect(Object.keys(written[0] as object)).toContain('image/png');
  });

  it('answers PNG where the browser has no way to be asked', async () => {
    const { written } = stubPlatform({ supports: undefined });
    const original = new File(['bytes'], 'ref.jpg', { type: 'image/jpeg' });

    expect(await copySelection([asset('a1')], new Map([['a1', original]]))).toBe('png');
    expect(Object.keys(written[0] as object)).toContain('image/png');
  });

  it('stays silent for a PNG original written as PNG, which changed nothing', async () => {
    stubPlatform({ supports: undefined });
    const original = new File(['bytes'], 'ref.png', { type: 'image/png' });

    expect(await copySelection([asset('a1')], new Map([['a1', original]]))).toBe('original');
  });
});

describe('the re-encode', () => {
  it('keeps the source pixel dimensions, whatever the format becomes', async () => {
    const { written, encoded } = stubPlatform({
      supports: () => false,
      decoded: { width: 6000, height: 4000 },
    });
    const original = new File(['bytes'], 'huge.jpg', { type: 'image/jpeg' });

    await copySelection([asset('a1')], new Map([['a1', original]]));
    const blob = await carried(written[0] as Record<string, unknown>, 'image/png');

    expect(encoded).toEqual([{ width: 6000, height: 4000 }]);
    expect(blob.type).toBe('image/png');
  });

  it('does not decode a blob that is already the type being written', async () => {
    stubPlatform({ supports: undefined });
    const original = new File(['bytes'], 'ref.png', { type: 'image/png' });

    await copySelection([asset('a1')], new Map([['a1', original]]));

    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('the floor under the image', () => {
  it('writes a URL per selected image in the same item, for a target that takes no image', async () => {
    const { written } = stubPlatform({ supports: undefined });
    const original = new File(['bytes'], 'ref.png', { type: 'image/png' });

    await copySelection([asset('a1'), asset('a2')], new Map([['a2', original]]));
    const text = await ((written[0] as Record<string, unknown>)['text/plain'] as Blob).text();

    expect(text.split('\n')).toEqual([
      `${location.origin}/api/assets/a1/content`,
      `${location.origin}/api/assets/a2/content`,
    ]);
  });
});

describe('when the clipboard is not there', () => {
  it('reports unavailable rather than throwing when the write is refused', async () => {
    stubPlatform({
      supports: undefined,
      write: vi.fn(async () => {
        throw new DOMException('not allowed', 'NotAllowedError');
      }),
    });
    const original = new File(['bytes'], 'ref.png', { type: 'image/png' });

    expect(await copySelection([asset('a1')], new Map([['a1', original]]))).toBe('unavailable');
  });

  it('reports unavailable on an origin with no Clipboard API at all', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('ClipboardItem', undefined);

    expect(await copySelection([asset('a1')], new Map())).toBe('unavailable');
  });
});

/**
 * A server that answers both halves: the bytes, and the asset record.
 *
 * `disposition` is what a CACHED `…/content` response carries — which is the
 * point of these tests, because that cache is immutable for a year.
 */
function stubServer({
  disposition,
  storedName,
  type = 'image/webp',
}: {
  disposition?: string;
  storedName?: string | null;
  type?: string;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.endsWith('/content')) {
        return new Response(JSON.stringify({ id: 'a1', originalFilename: storedName ?? null }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Blob(['bytes']), {
        headers: {
          'content-type': type,
          ...(disposition ? { 'content-disposition': disposition } : {}),
        },
      });
    }),
  );
}

describe('naming what leaves the browser', () => {
  it('takes the name from the asset record, which a rename actually changes', async () => {
    // The header on the bytes says the OLD name, because `…/content` is
    // immutable for a year and nothing revalidates it. The record is the truth.
    stubServer({
      disposition: 'inline; filename="before-the-rename.webp"',
      storedName: 'north-light.webp',
    });

    expect((await fetchOriginal('a1')).name).toBe('north-light.webp');
  });

  it('falls back to the header when the record cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.endsWith('/content')) return new Response('nope', { status: 500 });
        return new Response(new Blob(['bytes']), {
          headers: {
            'content-type': 'image/jpeg',
            'content-disposition': 'inline; filename="ref.jpg"; filename*=UTF-8\'\'r%C3%A9f.jpg',
          },
        });
      }),
    );

    expect((await fetchOriginal('a1')).name).toBe('réf.jpg');
  });

  it('names the file after the asset only when nothing else knows', async () => {
    // What a stale cached response produced for EVERY drag: no header, and
    // nobody asked the record. It is the last resort now, not the first.
    stubServer({ storedName: null, type: 'image/webp' });

    expect((await fetchOriginal('a1')).name).toBe('a1.webp');
  });

  it('takes the type from the bytes, which content addressing makes reliable', async () => {
    stubServer({ storedName: 'ref.webp', type: 'image/webp' });

    expect((await fetchOriginal('a1')).type).toBe('image/webp');
  });
});

describe('the warm', () => {
  it('abandons what has not arrived when the pointer leaves', async () => {
    const aborted: boolean[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => aborted.push(true));
        return new Response(new Blob(['bytes']), { headers: { 'content-type': 'image/png' } });
      }),
    );

    const warm = warmOriginals(['a1', 'a2']);
    warm.abort();

    // Two requests per asset — the bytes and the name — and one signal for both.
    expect(aborted).toHaveLength(4);
  });

  it('holds what did arrive, keyed by asset, for a dragstart to read synchronously', async () => {
    stubServer({ storedName: 'ref.png', type: 'image/png' });

    const warm = warmOriginals(['a1']);
    await vi.waitFor(() => expect(warm.originals.size).toBe(1));

    expect(warm.originals.get('a1')?.name).toBe('ref.png');
  });
});

describe('whether a drag out can go at all', () => {
  const original = new File(['bytes'], 'ref.png', { type: 'image/png' });

  it('goes when files travelled', () => {
    expect(dragNotice([asset('a1')], new Map([['a1', original]]))).toBeNull();
  });

  it('goes on a partial warm, which is the ordinary large selection', () => {
    expect(dragNotice([asset('a1'), asset('a2')], new Map([['a1', original]]))).toBeNull();
  });

  it('refuses, naming the fetch, when no original has arrived', () => {
    expect(dragNotice([asset('a1')], new Map())).toBe(NOTICES.notWarm);
  });

  it('refuses, naming the upload, when every selected item is still uploading', () => {
    expect(dragNotice([], new Map())).toBe(NOTICES.notStored);
  });
});
