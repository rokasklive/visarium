/**
 * Reference images for generated boards.
 *
 * Real files, so decode and texture upload cost what they cost — a board of flat
 * rectangles measures a renderer nobody is going to ship. Eight of them, reused
 * across every item: enough for real decode, not enough to exercise a bitmap
 * budget. That is M02's job (Q7), and the benchmark report says so.
 *
 * Provenance: see `web/public/bench/README.md`.
 */
export const BENCH_IMAGES = [
  '/bench/ref-1.png',
  '/bench/ref-2.jpg',
  '/bench/ref-3.png',
  '/bench/ref-4.jpg',
  '/bench/ref-5.jpg',
  '/bench/ref-6.jpg',
  '/bench/ref-7.png',
  '/bench/ref-8.jpg',
] as const;
