import {
  asAssetId,
  asCanvasId,
  asItemId,
  CanvasDocument,
  type CanvasOperationBody,
  newGroupId,
} from '@visarium/canvas-core';

/**
 * Boards to render before there is anything to load.
 *
 * The same generator serves the demo board and the benchmark: a benchmark board
 * that is not the thing people look at is a benchmark of something else. Output
 * is a pure function of `seed`, so a slow frame can be reproduced.
 *
 * Layout is deliberately uneven — tight clusters plus sparse outliers — because
 * a uniform grid is the one distribution a spatial index never struggles with.
 */

export interface BoardSpec {
  readonly count: number;
  readonly seed?: number;
  /** Number of dense clusters. The rest of the items are scattered. */
  readonly clusters?: number;
  /** Fraction of items that live in a cluster rather than in open space. */
  readonly clustered?: number;
  /** Half-width of the region scattered items spread over, in world units. */
  readonly extent?: number;
  /** Preview URLs cycled through the items. Empty means untextured boxes. */
  readonly images?: readonly string[];
  /**
   * Real uploaded assets, cycled through the items instead of preview URLs.
   *
   * This is what makes a memory measurement mean anything: each item carries a
   * real intrinsic size, so the tier it renders at is the tier a real board
   * would use, and the bitmaps the cache holds are the ones it would really
   * hold. A preview URL cannot do that — its intrinsic size is the box it was
   * drawn in.
   */
  readonly assets?: readonly BenchAsset[];
  /** Group every Nth run of items, so aggregation has groups to outline. */
  readonly groupSize?: number;
}

/** mulberry32 — 4 lines of seeded PRNG, no dependency. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BenchAsset {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

export function buildBoard(spec: BoardSpec): CanvasDocument {
  const {
    count,
    seed = 1,
    clusters = Math.max(1, Math.round(Math.sqrt(count) / 4)),
    clustered = 0.7,
    extent = Math.sqrt(count) * 900,
    images = [],
    assets = [],
    groupSize = 0,
  } = spec;

  const rng = random(seed);
  const doc = new CanvasDocument(asCanvasId(`bench-${count}-${seed}`));

  const centres = Array.from({ length: clusters }, (_, i) => ({
    // The first cluster sits on the origin, so the default camera opens onto
    // items rather than onto the empty space between them.
    x: i === 0 ? 0 : (rng() - 0.5) * 2 * extent,
    y: i === 0 ? 0 : (rng() - 0.5) * 2 * extent,
    spread: 400 + rng() * 2600,
  }));

  // Items are placed in runs that share a home, because that is how boards
  // really fill up — a handful of images dropped in one spot at one time. It
  // also keeps a group's bounds local, which is what makes an aggregate
  // outline mean anything.
  const run = Math.max(1, groupSize);
  let home = centres[0] ?? { x: 0, y: 0, spread: 800 };

  for (let i = 0; i < count; i++) {
    if (i % run === 0) {
      home =
        rng() < clustered
          ? (centres[Math.floor(rng() * centres.length)] ?? home)
          : { x: (rng() - 0.5) * 2 * extent, y: (rng() - 0.5) * 2 * extent, spread: 900 };
    }

    const size = 90 + rng() * 320;
    const asset = assets.length > 0 ? assets[i % assets.length] : undefined;
    // A real asset brings its own shape; a generated item invents one.
    const aspect = asset ? asset.height / asset.width : 0.6 + rng() * 1.1;
    const url = images.length > 0 ? images[i % images.length] : undefined;

    doc.apply({
      type: 'item.create',
      itemId: asItemId(`b-${i}`),
      transform: {
        x: home.x + (rng() - 0.5) * home.spread,
        y: home.y + (rng() - 0.5) * home.spread,
        width: size,
        height: size * aspect,
        // A tenth of the board is rotated: enough to exercise the conservative
        // AABB path in the index and in marquee selection.
        rotation: rng() < 0.1 ? (rng() - 0.5) * Math.PI : 0,
      },
      z: i,
      content: asset
        ? {
            kind: 'image',
            asset: {
              assetId: asAssetId(asset.assetId),
              intrinsicWidth: asset.width,
              intrinsicHeight: asset.height,
            },
          }
        : {
            kind: 'placeholder',
            intrinsicWidth: Math.round(size),
            intrinsicHeight: Math.round(size * aspect),
            ...(url !== undefined ? { previewUrl: url } : {}),
          },
    });
  }

  if (groupSize > 1) {
    for (let start = 0; start + groupSize <= count; start += groupSize * 8) {
      const memberIds = Array.from({ length: groupSize }, (_, k) => asItemId(`b-${start + k}`));
      doc.apply({ type: 'group.create', groupId: newGroupId(), memberIds } as CanvasOperationBody);
    }
  }

  return doc;
}
