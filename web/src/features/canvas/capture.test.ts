import {
  asAssetId,
  asCanvasId,
  asItemId,
  CanvasDocument,
  type ItemId,
  rect,
} from '@visarium/canvas-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_DRAG_TYPE,
  ASSET_ORIGIN_TYPE,
  assetUrlsFrom,
  createItem,
  createPlacement,
  imageFilesFrom,
  outwardAssets,
  PLACEMENT_FRACTION,
  placeCapture,
  readCapture,
  readTransfer,
  writeAssetTransfer,
} from './capture';

function file(name: string, type: string) {
  return new File(['bytes'], name, { type });
}

/** jsdom has no image decoder, so the one the capture path uses is stubbed. */
function stubDecoder(result: { width: number; height: number } | 'reject') {
  globalThis.createImageBitmap = vi.fn(async () =>
    result === 'reject'
      ? Promise.reject(new Error('not an image'))
      : ({ ...result, close: vi.fn() } as unknown as ImageBitmap),
  ) as unknown as typeof createImageBitmap;
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
});

describe('what a drop contains', () => {
  it('takes the images and leaves the rest', () => {
    const transfer = {
      files: [file('a.png', 'image/png'), file('notes.pdf', 'application/pdf')],
    } as unknown as DataTransfer;

    expect(imageFilesFrom(transfer).map((f) => f.name)).toEqual(['a.png']);
  });

  it('is empty when there is nothing to take', () => {
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

describe('reading a dropped file', () => {
  it('reads the intrinsic size locally, before any upload', async () => {
    stubDecoder({ width: 4000, height: 3000 });

    const capture = await readCapture(file('ref.jpg', 'image/jpeg'));

    expect(capture).toMatchObject({ width: 4000, height: 3000, previewUrl: 'blob:preview' });
    expect(capture?.itemId).toBeTruthy();
  });

  it('releases the full-size decode it only needed the dimensions from', async () => {
    stubDecoder({ width: 100, height: 100 });
    const decode = globalThis.createImageBitmap as unknown as ReturnType<typeof vi.fn>;

    await readCapture(file('ref.jpg', 'image/jpeg'));

    const bitmap = await decode.mock.results[0]?.value;
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('gives up on something the browser cannot decode', async () => {
    stubDecoder('reject');

    expect(await readCapture(file('broken.jpg', 'image/jpeg'))).toBeUndefined();
  });
});

describe('where placed items land, and at what size', () => {
  const capture = {
    itemId: 'i1',
    file: file('a.png', 'image/png'),
    previewUrl: 'blob:preview',
    width: 800,
    height: 600,
  } as unknown as Parameters<typeof placeCapture>[0];

  /** A 1000x1000 world rectangle centred on the origin. */
  const world = rect(-500, -500, 500, 500);

  it('places the first item on the drop point', () => {
    expect(placeCapture(capture, { x: 100, y: 50 }, 0, world)).toMatchObject({ x: 100, y: 50 });
  });

  it('cascades the rest so a folder drop is not one stack', () => {
    const first = placeCapture(capture, { x: 0, y: 0 }, 0, world);
    const third = placeCapture(capture, { x: 0, y: 0 }, 2, world);

    expect(third.x).toBeGreaterThan(first.x);
    expect(third.y).toBeGreaterThan(first.y);
  });

  it('scales a huge image down to the fraction, keeping its ratio', () => {
    const placed = placeCapture({ width: 6000, height: 4000 }, { x: 0, y: 0 }, 0, world);

    expect(placed.width).toBeCloseTo(1000 * PLACEMENT_FRACTION, 10);
    expect(placed.width / placed.height).toBeCloseTo(6000 / 4000, 10);
  });

  it('leaves a small icon alone rather than blowing it up', () => {
    expect(placeCapture({ width: 64, height: 64 }, { x: 0, y: 0 }, 0, world)).toMatchObject({
      width: 64,
      height: 64,
    });
  });

  it('sizes against what is visible, so zoom changes the answer', () => {
    const wide = placeCapture({ width: 6000, height: 4000 }, { x: 0, y: 0 }, 0, world);
    const zoomedIn = placeCapture(
      { width: 6000, height: 4000 },
      { x: 0, y: 0 },
      0,
      rect(-50, -50, 50, 50),
    );

    expect(zoomedIn.width).toBeLessThan(wide.width);
  });

  it('falls back to the intrinsic size when there is no viewport yet', () => {
    expect(
      placeCapture({ width: 800, height: 600 }, { x: 0, y: 0 }, 0, rect(0, 0, 0, 0)),
    ).toMatchObject({ width: 800, height: 600 });
  });
});

describe('the operation a drop produces', () => {
  it('creates a placeholder carrying the real size and a local preview', () => {
    const capture = {
      itemId: 'i1',
      file: file('a.png', 'image/png'),
      previewUrl: 'blob:preview',
      width: 800,
      height: 600,
    } as unknown as Parameters<typeof createItem>[0];

    const body = createItem(
      capture,
      placeCapture(capture, { x: 0, y: 0 }, 0, rect(-500, -500, 500, 500)),
      7,
    );

    expect(body).toMatchObject({
      type: 'item.create',
      z: 7,
      content: {
        kind: 'placeholder',
        intrinsicWidth: 800,
        intrinsicHeight: 600,
        previewUrl: 'blob:preview',
      },
    });
  });
});

describe('the operation a placement produces', () => {
  const asset = { assetId: 'a1' as never, width: 800, height: 600 };
  const at = placeCapture(asset, { x: 0, y: 0 }, 0, rect(-500, -500, 500, 500));

  it('creates image content from the asset the library already knows', () => {
    expect(createPlacement(asset, at, 3)).toMatchObject({
      type: 'item.create',
      z: 3,
      content: {
        kind: 'image',
        asset: { assetId: 'a1', intrinsicWidth: 800, intrinsicHeight: 600 },
      },
    });
  });

  it('mints a fresh item id per placement, so placing twice is two items', () => {
    const a = createPlacement(asset, at, 0) as { itemId: string };
    const b = createPlacement(asset, at, 1) as { itemId: string };

    expect(a.itemId).not.toEqual(b.itemId);
  });
});

/**
 * The departure half: what a selection puts on a transfer, and what reads it
 * back.
 *
 * The ordering rule between the two — a payload Visarium wrote beats the files
 * the browser synthesised beside it — is the thing most likely to be broken by
 * someone editing one of them, which is why both are tested here together.
 */

/** Enough of a `DataTransfer` to see what was written to it. happy-dom's is real but opaque. */
function transfer() {
  const written = new Map<string, string>();
  const added: File[] = [];
  const target = {
    effectAllowed: 'none',
    items: { add: (file: File) => added.push(file) },
    setData: (type: string, value: string) => void written.set(type, value),
    getData: (type: string) => written.get(type) ?? '',
  };
  return { transfer: target as unknown as DataTransfer, written, added };
}

/**
 * A board of images, stacked with the LAST one on top — so a correct writer
 * reverses nothing and an incorrect one is visible.
 */
function stack(assetIds: readonly (string | null)[]) {
  const doc = new CanvasDocument(asCanvasId('outward'));
  const ids: ItemId[] = [];
  assetIds.forEach((assetId, i) => {
    const itemId = asItemId(`i-${i}`);
    ids.push(itemId);
    doc.apply({
      type: 'item.create',
      itemId,
      transform: { x: 0, y: 0, width: 100, height: 80, rotation: 0 },
      z: i,
      content:
        assetId === null
          ? { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 80 }
          : {
              kind: 'image',
              asset: { assetId: asAssetId(assetId), intrinsicWidth: 100, intrinsicHeight: 80 },
            },
    });
  });
  return { doc, ids };
}

const original = (name: string) => new File(['bytes'], name, { type: 'image/jpeg' });

/** The board an outward drag left, which is what tells a drop it is coming home. */
const BOARD = 'outward';

describe('what a selection can hand out', () => {
  it('carries all three payloads, one entry per asset', () => {
    const { doc, ids } = stack(['a1', 'a2', 'a3']);
    const { transfer: t, written, added } = transfer();

    writeAssetTransfer(
      t,
      outwardAssets(doc, ids),
      new Map([
        ['a1', original('one.jpg')],
        ['a2', original('two.jpg')],
        ['a3', original('three.jpg')],
      ]),
      BOARD,
    );

    expect(JSON.parse(written.get(ASSET_DRAG_TYPE) as string)).toHaveLength(3);
    expect(added.map((f) => f.name)).toEqual(['one.jpg', 'two.jpg', 'three.jpg']);
    expect((written.get('text/plain') as string).split('\n')).toHaveLength(3);
  });

  it('writes the files bottom of the stack first, so a drop lands as the board reads', () => {
    const { doc, ids } = stack(['bottom', 'top']);

    expect(outwardAssets(doc, [ids[1] as ItemId, ids[0] as ItemId]).map((a) => a.assetId)).toEqual([
      'bottom',
      'top',
    ]);
  });

  it('sends one file for an asset placed twice, not two files with one name', () => {
    const { doc, ids } = stack(['same', 'same']);
    const { transfer: t, written, added } = transfer();

    writeAssetTransfer(
      t,
      outwardAssets(doc, ids),
      new Map([['same', original('same.jpg')]]),
      BOARD,
    );

    expect(added).toHaveLength(1);
    expect(JSON.parse(written.get(ASSET_DRAG_TYPE) as string)).toHaveLength(1);
  });

  it('leaves out a still-uploading item, which has nothing stored to hand over', () => {
    const { doc, ids } = stack(['a1', null]);
    const { transfer: t, written, added } = transfer();

    writeAssetTransfer(t, outwardAssets(doc, ids), new Map([['a1', original('one.jpg')]]), BOARD);

    expect(JSON.parse(written.get(ASSET_DRAG_TYPE) as string)).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(written.get('text/plain')).not.toContain('\n');
  });

  it('writes nothing at all when every selected item is still uploading', () => {
    const { doc, ids } = stack([null, null]);
    const { transfer: t, written, added } = transfer();

    writeAssetTransfer(t, outwardAssets(doc, ids), new Map(), BOARD);

    expect(written.size).toBe(0);
    expect(added).toHaveLength(0);
  });

  it('carries the other payloads when an original is not warm, and invents no substitute', () => {
    const { doc, ids } = stack(['a1', 'a2']);
    const { transfer: t, written, added } = transfer();

    writeAssetTransfer(t, outwardAssets(doc, ids), new Map([['a1', original('one.jpg')]]), BOARD);

    expect(added.map((f) => f.name)).toEqual(['one.jpg']);
    expect(JSON.parse(written.get(ASSET_DRAG_TYPE) as string)).toHaveLength(2);
  });
});

describe('reading the URL payload back', () => {
  it('round-trips exactly what the writer wrote', () => {
    // Real asset ids, because the reader matches the route strictly: an id that
    // is not shaped like one is not this application's content URL.
    const uuids = ['9d3f2a10-0000-4000-8000-000000000001', '9d3f2a10-0000-4000-8000-000000000002'];
    const { doc, ids } = stack(uuids);
    const { transfer: t, written } = transfer();
    writeAssetTransfer(t, outwardAssets(doc, ids), new Map(), BOARD);

    expect(assetUrlsFrom(written.get('text/plain'))).toEqual(uuids);
  });

  it('takes nothing from text that is merely text', () => {
    expect(assetUrlsFrom('A paragraph about kitchens, north light, and nothing else.')).toEqual([]);
    expect(assetUrlsFrom('')).toEqual([]);
    expect(assetUrlsFrom(null)).toEqual([]);
  });

  it('takes nothing from a URL that is not this route', () => {
    expect(assetUrlsFrom(`${location.origin}/api/assets/a1/derivatives/256`)).toEqual([]);
    expect(assetUrlsFrom('https://example.com/photo.jpg')).toEqual([]);
  });

  it('refuses the same route on another host, whose ids mean nothing here', () => {
    expect(assetUrlsFrom(`https://other.example/api/assets/${'0'.repeat(36)}/content`)).toEqual([]);
  });

  it('is all or nothing: one foreign line means the text was not ours', () => {
    const ours = `${location.origin}/api/assets/${'0'.repeat(36)}/content`;

    expect(assetUrlsFrom(`${ours}\nhttps://example.com/photo.jpg`)).toEqual([]);
  });
});

describe('which payload a reader believes', () => {
  const ours = `${location.origin}/api/assets/${'0'.repeat(36)}/content`;

  function arriving({
    assets,
    origin,
    text,
    files = [],
  }: {
    assets?: unknown;
    origin?: string;
    text?: string;
    files?: File[];
  }) {
    const written = new Map<string, string>();
    if (assets !== undefined) written.set(ASSET_DRAG_TYPE, JSON.stringify(assets));
    if (origin !== undefined) written.set(ASSET_ORIGIN_TYPE, origin);
    if (text !== undefined) written.set('text/plain', text);
    return {
      files,
      getData: (type: string) => written.get(type) ?? '',
    } as unknown as DataTransfer;
  }

  /** What the writer wrote, handed back to the reader exactly as a browser would. */
  function forwarded(written: Map<string, string>) {
    return {
      assets: JSON.parse(written.get(ASSET_DRAG_TYPE) as string) as unknown,
      origin: written.get(ASSET_ORIGIN_TYPE) as string,
      text: written.get('text/plain') as string,
    };
  }

  const photo = () => file('photo.jpg', 'image/jpeg');

  it('prefers our drag payload over the files carried beside it', () => {
    // A drag begun inside Visarium now carries all three. Reading the files
    // first would re-upload bytes this instance already has.
    const arrival = readTransfer(
      arriving({
        assets: [{ assetId: 'a1', width: 10, height: 10 }],
        text: ours,
        files: [photo()],
      }),
    );

    expect(arrival.kind).toBe('assets');
  });

  it('says which board an outward drag left, so a drop can tell it is coming home', () => {
    const { doc, ids } = stack(['a1']);
    const { transfer: t, written } = transfer();
    writeAssetTransfer(t, outwardAssets(doc, ids), new Map(), 'board-7');

    expect(readTransfer(arriving({ ...forwarded(written) }))).toMatchObject({
      kind: 'assets',
      origin: 'board-7',
    });
  });

  it('has no origin for a library drag, which came from no board', () => {
    const arrival = readTransfer(arriving({ assets: [{ assetId: 'a1', width: 1, height: 1 }] }));

    expect(arrival).toMatchObject({ kind: 'assets', origin: '' });
  });

  it('prefers our URL text over the image a clipboard carried beside it', () => {
    // A clipboard cannot carry the private type, so this is the only thing left
    // that says the paste came from Visarium.
    const arrival = readTransfer(arriving({ text: ours, files: [photo()] }));

    expect(arrival).toMatchObject({ kind: 'ids', assetIds: ['0'.repeat(36)] });
  });

  it('treats a transfer we did not write as bytes arriving, exactly as before', () => {
    const arrival = readTransfer(arriving({ text: 'a note about kitchens', files: [photo()] }));

    expect(arrival).toMatchObject({ kind: 'files' });
  });

  it('is nothing when there is nothing it can use', () => {
    expect(readTransfer(arriving({ text: 'just words' })).kind).toBe('nothing');
    expect(readTransfer(null).kind).toBe('nothing');
  });
});
