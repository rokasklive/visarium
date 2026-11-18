/**
 * Benchmark instrumentation.
 *
 * The canvas reports what it did; a Playwright script drives the tour and reads
 * the numbers back through `window.__bench`. Nothing here fabricates a metric:
 * frame timings come from rAF, the active-set cost is measured around the call,
 * and phases are labelled so "p95 during a drag" is not quietly reported as
 * "p95 while sitting still".
 *
 * ponytail: rAF deltas rather than Chrome tracing. Precision beyond "did we miss
 * 16 ms" is not what M01 needs; CDP can come when it is.
 */

export interface RenderSample {
  readonly activeSetMs: number;
  readonly nodes: number;
  readonly aggregated: number;
  readonly items: number;
  readonly truncated: boolean;
  /** Decoded-bitmap bytes held by the cache. Q7's budget, as observed. */
  readonly decodedBytes: number;
  /** How many bitmaps that is. A count alone cannot tell 200 thumbnails from 200 originals. */
  readonly bitmaps: number;
  /** Fetches or decodes that produced nothing. Zero, or the run means nothing. */
  readonly bitmapFailures: number;
}

interface Frame {
  readonly t: number;
  readonly phase: string;
}

let recording = false;
let phase = 'idle';
let handle = 0;
let frames: Frame[] = [];
let samples: RenderSample[] = [];
let firstRenderMs: number | undefined;

export function noteRender(sample: RenderSample): void {
  firstRenderMs ??= performance.now();
  if (recording) samples.push(sample);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] as number;
}

function summarise(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted.at(-1) ?? Number.NaN),
  };
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

function report() {
  const deltas = new Map<string, number[]>();
  for (let i = 1; i < frames.length; i++) {
    const current = frames[i] as Frame;
    const previous = frames[i - 1] as Frame;
    if (current.phase !== previous.phase) continue;
    const list = deltas.get(current.phase) ?? [];
    list.push(current.t - previous.t);
    deltas.set(current.phase, list);
  }

  const last = samples.at(-1);
  return {
    machine: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    board: {
      items: last?.items ?? 0,
      truncatedAtAnyPoint: samples.some((s) => s.truncated),
    },
    frameMsByPhase: Object.fromEntries([...deltas].map(([name, list]) => [name, summarise(list)])),
    activeSetMs: summarise(samples.map((s) => s.activeSetMs)),
    nodes: summarise(samples.map((s) => s.nodes)),
    aggregated: summarise(samples.map((s) => s.aggregated)),
    decodedMb: summarise(samples.map((s) => s.decodedBytes / (1024 * 1024))),
    bitmaps: summarise(samples.map((s) => s.bitmaps)),
    bitmapFailures: samples.at(-1)?.bitmapFailures ?? 0,
    /** Navigation start to the canvas' first render. */
    loadMs: round(firstRenderMs ?? Number.NaN),
  };
}

export type BenchReport = ReturnType<typeof report>;

export interface BenchHandle {
  start(): void;
  mark(name: string): void;
  stop(): BenchReport;
}

declare global {
  interface Window {
    __bench?: BenchHandle;
  }
}

export function installBench(): void {
  if (window.__bench) return;
  const tick = (t: number) => {
    frames.push({ t, phase });
    handle = requestAnimationFrame(tick);
  };
  window.__bench = {
    start() {
      frames = [];
      samples = [];
      phase = 'idle';
      recording = true;
      handle = requestAnimationFrame(tick);
    },
    mark(name: string) {
      phase = name;
    },
    stop() {
      cancelAnimationFrame(handle);
      recording = false;
      return report();
    },
  };
}
