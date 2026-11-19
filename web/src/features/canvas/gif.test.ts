import { describe, expect, it } from 'vitest';
import { decodeIndices, GifAnimation, type GifFrame, parseGif } from './gif';

/** The textbook LZW encoder, to round-trip the decoder through code-width growth and KwKwK. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map<string, number>();
  let next = clear + 2;
  emit(clear);
  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const wk = `${w},${indices[i]}`;
    if (table.has(wk)) {
      w = wk;
      continue;
    }
    emit(w.includes(',') ? (table.get(w) as number) : Number(w));
    if (next < 4096) {
      table.set(wk, next++);
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      emit(clear);
      table = new Map();
      next = clear + 2;
      size = minCodeSize + 1;
    }
    w = String(indices[i]);
  }
  emit(w.includes(',') ? (table.get(w) as number) : Number(w));
  emit(clear + 1);
  if (bits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

const frame = (width: number, height: number, data: Uint8Array, minCodeSize: number): GifFrame => ({
  x: 0,
  y: 0,
  width,
  height,
  delay: 100,
  disposal: 0,
  transparent: -1,
  interlaced: false,
  palette: new Uint8Array(3 << minCodeSize),
  minCodeSize,
  data,
});

/** Two 1x1 frames over a red/green/blue/black palette: red for 50 ms, then green for "0". */
// biome-ignore format: one line per GIF block
const TWO_FRAMES = Uint8Array.from([
  ...'GIF89a'.split('').map((c) => c.charCodeAt(0)),
  1, 0, 1, 0, 0x81, 0, 0, // 1x1, global palette of 4
  255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
  0x21, 0xf9, 4, 0, 5, 0, 0, 0, // 50 ms
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, // index 0
  0x21, 0xf9, 4, 0, 0, 0, 0, 0, // 0 ms: browsers make it 100
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0, // index 1
  0x3b,
]);

describe('gif', () => {
  it('round-trips LZW through every code width', () => {
    const n = 300 * 200;
    const indices = new Uint8Array(n);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      // Runs (KwKwK) mixed with noise, so the table fills and resets.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      indices[i] = i % 97 < 40 ? 3 : seed % 16;
    }
    expect(decodeIndices(frame(300, 200, lzw(indices, 4), 4))).toEqual(indices);
  });

  it('plays frames in order with browser delays, and loops', () => {
    const gif = parseGif(TWO_FRAMES);
    expect(gif.frames.map((f) => f.delay)).toEqual([50, 100]);
    const animation = new GifAnimation(gif);
    expect(animation.next()).toBe(50);
    expect([...animation.pixels]).toEqual([255, 0, 0, 255]);
    animation.next();
    expect([...animation.pixels]).toEqual([0, 255, 0, 255]);
    animation.next();
    expect([...animation.pixels]).toEqual([255, 0, 0, 255]);
  });

  it('refuses what is not a GIF', () => {
    expect(() => parseGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toThrow();
  });
});
