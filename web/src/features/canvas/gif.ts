/**
 * Animated GIFs on the board.
 *
 * The server's derivative ladder is still WebP, so a GIF is a still picture
 * until it is on screen. While it is, its original is fetched and played into a
 * canvas that stands in for the still bitmap. Our own decoder rather than
 * WebCodecs' `ImageDecoder`: Safari, and so the macOS desktop webview, has none.
 *
 * Memory is one composited frame per playing GIF, whatever its frame count:
 * frames stay LZW-compressed and are decoded one at a time as they come due.
 */

import type { AssetId, CanvasItem, VisibleItem } from '@visarium/canvas-core';
import { useEffect, useReducer, useRef } from 'react';
import { bitmapUrl } from './bitmap-cache';

// --- limits -------------------------------------------------------------------

/** At most this many GIFs animate at once; the largest on screen win, the rest stay still. */
export const MAX_PLAYING = 8;
/** Larger originals stay still: a frame is decoded on the main thread. */
const MAX_PIXELS = 2_000_000;
const MAX_BYTES = 32 * 1024 * 1024;
/** Narrower than this on screen, the motion is not worth the decode. */
const MIN_SCREEN_WIDTH = 48;
/** What every browser does with a 0 or 10 ms delay: such GIFs were authored for 100 ms. */
const MIN_DELAY_MS = 20;
const DEFAULT_DELAY_MS = 100;

// --- the format ---------------------------------------------------------------

export interface GifFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Milliseconds, already normalised the way browsers do. */
  readonly delay: number;
  /** 2 = clear to transparent afterwards, 3 = restore what was there. */
  readonly disposal: number;
  /** Palette index that is not drawn, or -1. */
  readonly transparent: number;
  readonly interlaced: boolean;
  /** RGB triples. */
  readonly palette: Uint8Array;
  readonly minCodeSize: number;
  /** The frame's LZW stream, sub-blocks joined. */
  readonly data: Uint8Array;
}

export interface Gif {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly GifFrame[];
}

/** Every frame's header and compressed data. A truncated file keeps the frames that were whole. */
export function parseGif(bytes: Uint8Array): Gif {
  const tag = String.fromCharCode(...bytes.subarray(0, 6));
  if (tag !== 'GIF87a' && tag !== 'GIF89a') throw new Error('not a GIF');
  const u16 = (at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const width = u16(6);
  const height = u16(8);
  const screen = bytes[10] ?? 0;
  let p = 13;
  let global: Uint8Array | undefined;
  if (screen & 0x80) {
    const n = 3 << ((screen & 7) + 1);
    global = bytes.subarray(p, p + n);
    p += n;
  }

  const blocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let n = bytes[p++] ?? 0; n > 0 && p < bytes.length; n = bytes[p++] ?? 0) {
      parts.push(bytes.subarray(p, p + n));
      total += n;
      p += n;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };

  const frames: GifFrame[] = [];
  let delay = 0;
  let disposal = 0;
  let transparent = -1;
  while (p < bytes.length) {
    const introducer = bytes[p++];
    if (introducer === 0x21) {
      const label = bytes[p++];
      const body = blocks();
      if (label === 0xf9 && body.length >= 4) {
        const packed = body[0] ?? 0;
        disposal = (packed >> 2) & 7;
        delay = ((body[1] ?? 0) | ((body[2] ?? 0) << 8)) * 10;
        transparent = packed & 1 ? (body[3] ?? -1) : -1;
      }
      continue;
    }
    if (introducer !== 0x2c) break; // the trailer, or garbage: keep what parsed
    const x = u16(p);
    const y = u16(p + 2);
    const w = u16(p + 4);
    const h = u16(p + 6);
    const packed = bytes[p + 8] ?? 0;
    p += 9;
    let palette = global;
    if (packed & 0x80) {
      const n = 3 << ((packed & 7) + 1);
      palette = bytes.subarray(p, p + n);
      p += n;
    }
    const minCodeSize = bytes[p++] ?? 0;
    const data = blocks();
    if (palette && w > 0 && h > 0 && minCodeSize >= 2 && minCodeSize <= 11) {
      frames.push({
        x,
        y,
        width: w,
        height: h,
        delay: delay < MIN_DELAY_MS ? DEFAULT_DELAY_MS : delay,
        disposal,
        transparent,
        interlaced: (packed & 0x40) !== 0,
        palette,
        minCodeSize,
        data,
      });
    }
    delay = 0;
    disposal = 0;
    transparent = -1;
  }
  return { width, height, frames };
}

/** A frame's palette indices, row-major. A short stream leaves the rest at 0. */
export function decodeIndices(frame: GifFrame): Uint8Array {
  const { minCodeSize, data } = frame;
  const out = new Uint8Array(frame.width * frame.height);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let size = minCodeSize + 1;
  let next = clear + 2;
  let old = -1;
  let first = 0;
  let acc = 0;
  let bits = 0;
  let o = 0;

  for (let i = 0; i < data.length && o < out.length; ) {
    acc |= (data[i++] as number) << bits;
    bits += 8;
    while (bits >= size && o < out.length) {
      let code = acc & ((1 << size) - 1);
      acc >>>= size;
      bits -= size;
      if (code === clear) {
        size = minCodeSize + 1;
        next = clear + 2;
        old = -1;
        continue;
      }
      if (code === end) return out;
      if (old === -1) {
        if (code >= clear) continue; // corrupt: the first code must be a literal
        out[o++] = code;
        old = first = code;
        continue;
      }
      const incoming = code;
      let top = 0;
      if (code >= next) {
        // The code being defined right now (KwKwK).
        stack[top++] = first;
        code = old;
      }
      while (code > end) {
        stack[top++] = suffix[code] as number;
        code = prefix[code] as number;
      }
      first = code;
      stack[top++] = code;
      while (top > 0 && o < out.length) out[o++] = stack[--top] as number;
      if (next < 4096) {
        prefix[next] = old;
        suffix[next] = first;
        next++;
        if (next === 1 << size && size < 12) size++;
      }
      old = incoming;
    }
  }
  return out;
}

/** Interlaced rows arrive in four passes; this is where decoded row `r` belongs. */
function interlacedRows(height: number): Uint32Array {
  const rows = new Uint32Array(height);
  let r = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let y = start; y < height; y += step) rows[r++] = y;
  }
  return rows;
}

/** A GIF composited frame by frame into one RGBA buffer, the way a browser plays it. */
export class GifAnimation {
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly #gif: Gif;
  #index = -1;
  /** What the shown frame's disposal needs undone before the next one draws. */
  #saved: Uint8ClampedArray | undefined;

  constructor(gif: Gif) {
    this.#gif = gif;
    this.pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
  }

  /** Draw the next frame (wrapping to the first) and return how long it stays up. */
  next(): number {
    const { frames, width } = this.#gif;
    const shown = frames[this.#index];
    if (shown?.disposal === 2) this.#each(shown, (at) => this.pixels.fill(0, at, at + 4));
    if (shown?.disposal === 3 && this.#saved) {
      const saved = this.#saved;
      let s = 0;
      this.#each(shown, (at) => {
        this.pixels.set(saved.subarray(s, s + 4), at);
        s += 4;
      });
    }

    this.#index = (this.#index + 1) % frames.length;
    if (this.#index === 0) this.pixels.fill(0); // ponytail: loops forever; NETSCAPE loop counts are ignored
    const frame = frames[this.#index] as GifFrame;

    if (frame.disposal === 3) {
      const saved = new Uint8ClampedArray(frame.width * frame.height * 4);
      let s = 0;
      this.#each(frame, (at) => {
        saved.set(this.pixels.subarray(at, at + 4), s);
        s += 4;
      });
      this.#saved = saved;
    }

    const indices = decodeIndices(frame);
    const rows = frame.interlaced ? interlacedRows(frame.height) : undefined;
    const { palette, transparent } = frame;
    for (let r = 0; r < frame.height; r++) {
      const y = frame.y + (rows ? (rows[r] as number) : r);
      if (y >= this.#gif.height) continue;
      for (let c = 0; c < frame.width; c++) {
        const x = frame.x + c;
        if (x >= width) break;
        const index = indices[r * frame.width + c] as number;
        if (index === transparent || index * 3 >= palette.length) continue;
        const at = (y * width + x) * 4;
        this.pixels[at] = palette[index * 3] as number;
        this.pixels[at + 1] = palette[index * 3 + 1] as number;
        this.pixels[at + 2] = palette[index * 3 + 2] as number;
        this.pixels[at + 3] = 255;
      }
    }
    return frame.delay;
  }

  /** Every on-canvas pixel offset of a frame's rectangle, in row order. */
  #each(frame: GifFrame, visit: (at: number) => void): void {
    const { width, height } = this.#gif;
    for (let y = frame.y; y < Math.min(frame.y + frame.height, height); y++) {
      for (let x = frame.x; x < Math.min(frame.x + frame.width, width); x++)
        visit((y * width + x) * 4);
    }
  }
}

// --- playback -----------------------------------------------------------------

export function isGif(item: CanvasItem): boolean {
  return item.content.kind === 'image' && item.content.asset.mimeType === 'image/gif';
}

/** One GIF asset being played into a canvas. Two items of one asset share it. */
class GifPlayer {
  readonly canvas = document.createElement('canvas');
  readonly #animation: GifAnimation;
  readonly #image: ImageData;
  readonly #context: CanvasRenderingContext2D;
  readonly #onFrame: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #delay = 0;

  constructor(gif: Gif, onFrame: () => void) {
    this.canvas.width = gif.width;
    this.canvas.height = gif.height;
    this.#context = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.#animation = new GifAnimation(gif);
    this.#image = new ImageData(this.#animation.pixels, gif.width, gif.height);
    this.#onFrame = onFrame;
    this.#step(); // the first frame at once, so the swap from the still is seamless
  }

  play(): void {
    if (this.#timer === undefined) this.#timer = setTimeout(this.#tick, this.#delay);
  }

  pause(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.pause();
    // Releases the backing store now rather than whenever the element is collected.
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  readonly #tick = () => {
    // A hidden tab decodes nothing; it looks again shortly.
    if (!document.hidden) this.#step();
    this.#timer = setTimeout(this.#tick, document.hidden ? 500 : this.#delay);
  };

  #step(): void {
    this.#delay = this.#animation.next();
    this.#context.putImageData(this.#image, 0, 0);
    this.#onFrame();
  }
}

/** The GIF assets that should be playing now: on screen, big enough, largest first. */
export function playingAssets(
  visible: readonly VisibleItem[],
  zoom: number,
  drawn: (lod: VisibleItem['lod']) => boolean,
): AssetId[] {
  const area = new Map<AssetId, number>();
  for (const { item, lod } of visible) {
    if (item.content.kind !== 'image' || !isGif(item) || !drawn(lod)) continue;
    const { asset } = item.content;
    if (asset.intrinsicWidth * asset.intrinsicHeight > MAX_PIXELS) continue;
    const w = item.transform.width * zoom;
    if (w < MIN_SCREEN_WIDTH) continue;
    area.set(
      asset.assetId,
      Math.max(area.get(asset.assetId) ?? 0, w * item.transform.height * zoom),
    );
  }
  return [...area]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PLAYING)
    .map(([id]) => id);
}

/**
 * Plays the on-screen GIFs. `canvasFor` is what to draw instead of the still;
 * `onFrame` repaints after each frame without a React render.
 */
export function useGifs(
  visible: readonly VisibleItem[],
  zoom: number,
  paused: boolean,
  drawn: (lod: VisibleItem['lod']) => boolean,
  onFrame: () => void,
) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const players = useRef(new Map<AssetId, GifPlayer>());
  const loading = useRef(new Map<AssetId, AbortController>());
  /** Assets that turned out not to animate (one frame, too large, unreadable): never fetched again. */
  const still = useRef(new Set<AssetId>());
  const frame = useRef(onFrame);
  frame.current = onFrame;

  const wanted = playingAssets(visible, zoom, drawn).filter((id) => !still.current.has(id));
  const key = wanted.join(',');

  useEffect(() => {
    const keep = new Set(key ? (key.split(',') as AssetId[]) : []);
    for (const [id, player] of players.current) {
      if (keep.has(id)) continue;
      player.dispose();
      players.current.delete(id);
      redraw();
    }
    for (const [id, controller] of loading.current) {
      if (keep.has(id)) continue;
      controller.abort();
      loading.current.delete(id);
    }
    for (const id of keep) {
      if (players.current.has(id) || loading.current.has(id)) continue;
      const controller = new AbortController();
      loading.current.set(id, controller);
      void (async () => {
        try {
          const response = await fetch(bitmapUrl({ kind: 'asset', assetId: id }, 'original'), {
            signal: controller.signal,
          });
          if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
            throw new Error('not playable');
          }
          const gif = parseGif(new Uint8Array(await response.arrayBuffer()));
          if (controller.signal.aborted) return;
          if (gif.frames.length < 2 || gif.width * gif.height > MAX_PIXELS)
            throw new Error('still');
          players.current.set(id, new GifPlayer(gif, () => frame.current()));
          redraw();
        } catch {
          if (!controller.signal.aborted) still.current.add(id);
        } finally {
          if (loading.current.get(id) === controller) loading.current.delete(id);
        }
      })();
    }
  }, [key]);

  // After the effect above, so a player that just landed starts in the right state.
  useEffect(() => {
    for (const player of players.current.values()) paused ? player.pause() : player.play();
  });

  useEffect(
    () => () => {
      for (const player of players.current.values()) player.dispose();
      for (const controller of loading.current.values()) controller.abort();
      players.current.clear();
      loading.current.clear();
    },
    [],
  );

  return {
    canvasFor(item: CanvasItem): HTMLCanvasElement | undefined {
      return item.content.kind === 'image'
        ? players.current.get(item.content.asset.assetId)?.canvas
        : undefined;
    },
  };
}
