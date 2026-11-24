import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { BenchReport } from '../src/features/canvas/bench';
import { canvasBox, signedIn } from './session';

/**
 * Q7: what decoded-bitmap memory actually does on a board of real images.
 *
 * M01's benchmark could not answer this — eight fixture files reused across
 * 100,000 items exercise a cache that holds eight things. This board is built
 * from whatever the library really holds, so every item carries a real
 * intrinsic size and the cache holds the tiers a real board would hold.
 *
 * Needs a server with assets in it. Skipped otherwise, because a memory
 * measurement against an empty library is a measurement of nothing:
 *
 *   docker compose up -d && drop some images onto a board
 *   pnpm --filter @visarium/web measure
 *
 * Not part of `test:e2e`, and one worker on purpose. These are timings, and a
 * timing taken while five other browsers fight for the same cores is a timing
 * of the machine's load rather than of the product.
 */

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results');

async function libraryHasAssets(page: Page): Promise<number> {
  try {
    const response = await page.request.get('/api/assets?limit=200');
    if (!response.ok()) return 0;
    // M04 made this a paged envelope; it was a bare array through M03.
    return (((await response.json()) as { assets?: unknown[] }).assets ?? []).length;
  } catch {
    return 0;
  }
}

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('decoded-bitmap memory stays under budget across a pan tour', async ({ page }) => {
  const assets = await libraryHasAssets(page);
  test.skip(assets === 0, 'no assets in the library; nothing to measure');

  await page.goto('/boards/assets');
  await expect(page.getByTestId('canvas-stats')).toBeVisible();

  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Give the first screenful time to fetch and decode before measuring.
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__bench?.start());

  // 1. Sit on a dense region at full detail: the largest tiers, all at once.
  await page.evaluate(() => window.__bench?.mark('dense'));
  await page.waitForTimeout(1500);

  // 2. Pan across the board, pulling new regions in and pushing old ones out.
  await page.evaluate(() => window.__bench?.mark('pan'));
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx - i * 18, cy - i * 6);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');

  // 3. Zoom in hard: the tier every visible item wants goes up.
  await page.evaluate(() => window.__bench?.mark('zoom-in'));
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(60);
  }
  // Long enough for the debounced upgrade to fire and the top tiers to land.
  await page.waitForTimeout(2500);

  // 4. Zoom back out: tiers drop, and memory should come back with them.
  await page.evaluate(() => window.__bench?.mark('zoom-out'));
  for (let i = 0; i < 16; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);

  const report = (await page.evaluate(() => window.__bench?.stop())) as BenchReport;

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, 'memory.json'),
    JSON.stringify({ assetsInLibrary: assets, ...report }, null, 2),
  );

  console.log(
    `decoded MB  p50 ${report.decodedMb.p50}  p95 ${report.decodedMb.p95}  max ${report.decodedMb.max}`,
  );
  console.log(`bitmaps held  p50 ${report.bitmaps.p50}  max ${report.bitmaps.max}`);
  console.log(`frame ms by phase ${JSON.stringify(report.frameMsByPhase)}`);

  // The budget is the assertion. A board that cannot stay inside it is the
  // finding, not a flaky test.
  expect(report.decodedMb.max).toBeLessThan(256);
  expect(report.bitmapFailures).toBe(0);
});

/**
 * The same tour with the budget set below what the board wants.
 *
 * Eviction is unit-tested, but a cache that evicts correctly in a test and
 * leaks in a browser is the failure this milestone is about. This is the only
 * way to see `close()` do its job against real decoded bitmaps.
 */
test('holds the line when the budget is smaller than the board', async ({ page }) => {
  const assets = await libraryHasAssets(page);
  test.skip(assets === 0, 'no assets in the library; nothing to measure');

  const BUDGET_MB = 6;
  await page.goto(`/boards/assets?budget=${BUDGET_MB}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();

  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__bench?.start());
  await page.evaluate(() => window.__bench?.mark('pressure'));

  await page.mouse.move(cx, cy);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 0; i < 80; i++) {
    await page.mouse.move(cx - i * 22, cy - i * 9);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(1500);

  const report = (await page.evaluate(() => window.__bench?.stop())) as BenchReport;
  writeFileSync(
    join(RESULTS, 'memory-under-pressure.json'),
    JSON.stringify({ budgetMb: BUDGET_MB, ...report }, null, 2),
  );

  console.log(
    `under a ${BUDGET_MB} MB budget: decoded p50 ${report.decodedMb.p50} max ${report.decodedMb.max} MB, ` +
      `${report.bitmaps.max} bitmaps at most, frames ${JSON.stringify(report.frameMsByPhase.pressure)}`,
  );

  // Pinning means the active set can push past the budget rather than dropping
  // something on screen; what must not happen is unbounded growth.
  expect(report.decodedMb.max).toBeLessThan(BUDGET_MB * 4);
  expect(report.bitmapFailures).toBe(0);
});

/**
 * Invariant 4, measured: uploading must not cost the canvas frames.
 *
 * A bulk drop is the worst case the client has — reading every file, decoding
 * every one for its dimensions, minting items, and running the queue — and all
 * of it happens while the user is still moving the camera.
 */
test('a bulk drop does not cost frames', async ({ page }) => {
  const assets = await libraryHasAssets(page);
  test.skip(assets === 0, 'needs a server to upload to');

  await page.goto('/boards/assets');
  await expect(page.getByTestId('canvas-stats')).toBeVisible();

  const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench');
  const files = readdirSync(fixtures)
    .filter((name) => /\.(png|jpg)$/.test(name))
    .map((name) => ({ name, bytes: [...readFileSync(join(fixtures, name))] }));

  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.waitForTimeout(1500);

  // Built BEFORE recording starts: marshalling a megabyte of fixture bytes into
  // the page is the harness' cost, and counting it as a dropped frame would be
  // measuring Playwright.
  const transfer = await page.evaluateHandle(async (entries) => {
    const dt = new DataTransfer();
    for (const entry of entries) {
      dt.items.add(
        new File([new Uint8Array(entry.bytes)], entry.name, {
          type: entry.name.endsWith('.png') ? 'image/png' : 'image/jpeg',
        }),
      );
    }
    return dt;
  }, files);
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__bench?.start());
  await page.evaluate(() => window.__bench?.mark('drop-and-pan'));

  await page.dispatchEvent('canvas', 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'drop', {
    dataTransfer: transfer,
    clientX: cx,
    clientY: cy,
  });

  // Keep moving the camera while the uploads run: the point is that they do not
  // compete with the interaction loop.
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 0; i < 70; i++) {
    await page.mouse.move(cx - i * 12, cy - i * 5);
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(2000);

  const report = (await page.evaluate(() => window.__bench?.stop())) as BenchReport;
  writeFileSync(
    join(RESULTS, 'bulk-drop.json'),
    JSON.stringify({ droppedFiles: files.length, ...report }, null, 2),
  );

  console.log(
    `bulk drop of ${files.length} while panning: ${JSON.stringify(report.frameMsByPhase['drop-and-pan'])}`,
  );

  // 16.7 ms is one frame at 60 Hz; two frames is the budget a gesture may miss.
  expect(report.frameMsByPhase['drop-and-pan']?.p95 ?? 999).toBeLessThan(33.4);
});

/**
 * M03: what a board costs to load.
 *
 * Two numbers nobody had before: what a snapshot weighs on the wire and how
 * long it takes to become a document on screen. Both are needed to say whether
 * "one response per board" has a size at which it stops being reasonable — see
 * OPEN_QUESTIONS Q12.
 *
 * Mid-sized on purpose. A 100,000-item board is a benchmark fixture, not
 * something anyone arranged by hand, and persisting one to time the loading of
 * it would measure a board that does not exist.
 */
const SNAPSHOT_ITEMS = 2_000;

test('a mid-sized board loads in one response', async ({ page, context }) => {
  const assets = await libraryHasAssets(page);
  test.skip(assets === 0, 'no assets in the library; nothing to put on a board');

  const library = (
    (await (await page.request.get('/api/assets?limit=200')).json()) as {
      assets: { id: string; width: number; height: number }[];
    }
  ).assets;

  await page.goto('/');
  const token = (await context.cookies()).find((cookie) => cookie.name === 'XSRF-TOKEN')?.value;
  const headers = { 'X-XSRF-TOKEN': token ?? '' };

  const board = (await (
    await page.request.post('/api/boards', { headers, data: { title: 'load measurement' } })
  ).json()) as { id: string };

  // Posted in batches, because the point is to measure the LOAD, not to
  // discover how large a single request body can get.
  for (let start = 0; start < SNAPSHOT_ITEMS; start += 250) {
    const operations = Array.from({ length: 250 }, (_, i) => {
      const asset = library[(start + i) % library.length] as (typeof library)[number];
      return {
        operationId: crypto.randomUUID(),
        baseRevision: 0,
        body: {
          type: 'item.create',
          itemId: crypto.randomUUID(),
          transform: {
            x: ((start + i) % 50) * 420,
            y: Math.floor((start + i) / 50) * 320,
            width: 300,
            height: (300 * asset.height) / asset.width,
            rotation: 0,
          },
          z: start + i,
          content: {
            kind: 'image',
            asset: {
              assetId: asset.id,
              intrinsicWidth: asset.width,
              intrinsicHeight: asset.height,
            },
          },
        },
      };
    });
    await page.request.post(`/api/boards/${board.id}/operations`, {
      headers,
      data: { operations },
    });
  }

  const startedAt = Date.now();
  const snapshot = await page.request.get(`/api/boards/${board.id}/snapshot`);
  const serverMs = Date.now() - startedAt;
  // The payload, decompressed. The wire cost is NOT measurable here: a gzipped
  // response is chunked, so there is no Content-Length, and Playwright hands
  // back the decoded body either way. The compression ratio is measured with
  // curl instead and recorded in OPEN_QUESTIONS.md (Q12); this asserts only
  // that compression is switched on, which is the part that can regress.
  const bytes = (await snapshot.body()).length;
  const encoding = snapshot.headers()['content-encoding'] ?? 'identity';
  expect(encoding).toBe('gzip');

  const openedAt = Date.now();
  await page.goto(`/boards/${board.id}`);
  await expect
    .poll(async () => (await page.getByTestId('canvas-stats').textContent()) ?? '', {
      timeout: 30_000,
    })
    .toContain(`${SNAPSHOT_ITEMS.toLocaleString()} items`);
  const clientMs = Date.now() - openedAt;

  console.log(
    `snapshot ${SNAPSHOT_ITEMS} items  ${(bytes / 1024).toFixed(0)} KB  ` +
      `${(bytes / SNAPSHOT_ITEMS).toFixed(0)} B/item  server ${serverMs} ms  ` +
      `open-to-drawn ${clientMs} ms  sent as ${encoding}`,
  );
});
