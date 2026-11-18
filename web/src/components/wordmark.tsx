import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * "Visarium" in the identity face, drawn from the face's own dot grid.
 *
 * Set as text, the face smeared, and differently on every screen. Each of its
 * pixels is a square 0.045em dot, and at the 32px the face reads at a dot is
 * 1.44 px, starting wherever the glyph lands. Rasterising that spreads every dot
 * across two pixels at a fraction of the ink, and how much depends on the
 * screen's density and the element's position: muddy at 1x, uneven at 1.25x and
 * 1.5x. `-webkit-font-smoothing: none` only reaches macOS Safari, so it could
 * not hold the grid anywhere else.
 *
 * So the word is the dots themselves, laid out in device pixels. The pitch is
 * the face's 2.88 CSS px rounded to whole device pixels for the screen in front
 * of us, a dot is the larger half of it, and `crispEdges` keeps every edge on a
 * pixel boundary. Every dot comes out solid and the same size as its
 * neighbours. On an odd pitch (1x: 3 px) dot and gap differ by a pixel, and a
 * letter that starts half a pitch over lands a pixel early; both read as the
 * face, where a smeared dot does not. The word's CSS size moves a little between
 * densities (120 to 144 px wide, against 130 as text): a crisp grid is the point
 * of the face, and an exact size is not.
 *
 * The map was read from `public/fonts/editundo-dot.ttf`, set at 1000px and
 * sampled per 0.045em cell. Letters sit half a pitch apart in places, which is
 * why the columns run on the 0.045em unit and not the 0.09em pitch. Rows are
 * every other unit, so only the inked rows are listed. The face still sets
 * people's names in presence labels: those are live text and stay text.
 */
const ROWS: readonly [string, ...string[]] = [
  '#.#.....#.#..#.#....#.#.#.#.#....#.#.#.#......#.#.#.#....#.#..#.#.....#.#....#.#.#.#.#.#..',
  '#.#.....#.#..#.#..#.#.#.#.#.#..#.#.#.#.#.#..#.#.#.#.#.#..#.#..#.#.....#.#..#.#.#.#.#.#.#.#',
  '#.#.....#.#..#.#..#.#..........#.#.....#.#..#.#.....#.#..#.#..#.#.....#.#..#.#...#.#...#.#',
  '#.#.....#.#..#.#..#.#.#.#.#....#.#.#.#.#.#..#.#.#.#.#.#..#.#..#.#.....#.#..#.#...#.#...#.#',
  '#.#.....#.#..#.#....#.#.#.#.#..#.#.#.#.#.#..#.#.#.#.#....#.#..#.#.....#.#..#.#...#.#...#.#',
  '#.#.#.#.#.#..#.#..........#.#..#.#.....#.#..#.#...#.#.#..#.#..#.#.....#.#..#.#...#.#...#.#',
  '..#.#.#.#....#.#..#.#.#.#.#.#..#.#.....#.#..#.#.....#.#..#.#..#.#.#.#.#.#..#.#...#.#...#.#',
  '....#.#......#.#..#.#.#.#.#....#.#.....#.#..#.#.....#.#..#.#....#.#.#.#....#.#...#.#...#.#',
];

/** How the grid lands on one screen, in device pixels. */
export function wordmarkLayout(dpr: number): { pitch: number; dot: number; path: string } {
  const pitch = Math.max(2, Math.round(2.88 * dpr));
  const dot = Math.ceil(pitch / 2);
  // Columns run on the half-pitch unit; floored, so a letter keeps its own
  // spacing exact and only the half-pitch joins between letters round.
  const path = ROWS.flatMap((row, r) =>
    [...row].flatMap((cell, k) =>
      cell === '#' ? [`M${Math.floor((k * pitch) / 2)} ${r * pitch}h${dot}v${dot}h-${dot}z`] : [],
    ),
  ).join('');
  return { pitch, dot, path };
}

/**
 * The nearest whole CSS pixel that is also a whole device pixel (`up`: the
 * nearest at or above `v`).
 *
 * Chrome snaps an SVG's box to whole CSS pixels and then scales the drawing to
 * fit what it snapped to. A box that sits on whole device pixels but not whole
 * CSS ones (6 device px is 4.8 CSS px at 1.25x), or the other way round (4.5
 * CSS px at 2x), gets stretched by a pixel, and the dots blend at the edges or
 * lose a row. Only a box on both grids is drawn 1:1. At 1.25x and 1.75x that
 * grid is every 4 CSS px, so the mark can sit up to 2 px from where layout put
 * it. A density with no such pixel nearby (browser zoom at 110%) takes the
 * nearest whole CSS pixel and is merely close.
 */
export function onBothGrids(v: number, dpr: number, up = false): number {
  const start = up ? Math.ceil(v - 1e-6) : Math.round(v);
  for (let step = 0; step <= 10; step++) {
    for (const c of up ? [start + step] : [start - step, start + step]) {
      if (Math.abs(c * dpr - Math.round(c * dpr)) < 1e-3) return c;
    }
  }
  return start;
}

export function Wordmark({ className }: { className?: string }) {
  const dpr = useDevicePixelRatio();
  const { pitch, dot, path } = useMemo(() => wordmarkLayout(dpr), [dpr]);
  // The drawing in device pixels, and a box on both grids at least that big,
  // so the viewBox is the box in device pixels and maps 1:1.
  const box = {
    width: onBothGrids((Math.floor(((ROWS[0].length - 1) * pitch) / 2) + dot) / dpr, dpr, true),
    height: onBothGrids(((ROWS.length - 1) * pitch + dot) / dpr, dpr, true),
  };
  const ref = useRef<SVGSVGElement>(null);

  // The position, put on both grids too, and again whenever the layout around
  // the mark can move. A relative offset rather than a transform: a transform
  // has the compositor resample the mark even when it lands on whole pixels.
  useLayoutEffect(() => {
    const mark = ref.current;
    if (!mark) return;
    const snap = () => {
      mark.style.left = '';
      mark.style.top = '';
      const at = mark.getBoundingClientRect();
      mark.style.left = `${onBothGrids(at.left, dpr) - at.left}px`;
      mark.style.top = `${onBothGrids(at.top, dpr) - at.top}px`;
    };
    snap();
    const observer = globalThis.ResizeObserver ? new ResizeObserver(snap) : undefined;
    if (mark.parentElement) observer?.observe(mark.parentElement);
    globalThis.addEventListener('resize', snap);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener('resize', snap);
    };
  }, [dpr]);

  return (
    <svg
      ref={ref}
      role="img"
      aria-label="Visarium"
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${Math.round(box.width * dpr)} ${Math.round(box.height * dpr)}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      className={`relative block shrink-0 ${className ?? ''}`}
    >
      <path d={path} />
    </svg>
  );
}

/*
 * The density changes when the window moves to another screen or the page is
 * zoomed. A `resolution` query matches only the density it was made for, so it
 * fires once on leaving it and is re-armed for the new one.
 */
function subscribe(onChange: () => void): () => void {
  let media: MediaQueryList | undefined;
  const arm = () => {
    media?.removeEventListener('change', fire);
    media = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio}dppx)`);
    media?.addEventListener('change', fire);
  };
  const fire = () => {
    arm();
    onChange();
  };
  arm();
  return () => media?.removeEventListener('change', fire);
}

function useDevicePixelRatio(): number {
  return useSyncExternalStore(
    subscribe,
    () => globalThis.devicePixelRatio || 1,
    () => 1,
  );
}
