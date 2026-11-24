import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { BenchReport } from '../src/features/canvas/bench';
import { canvasBox, signedIn } from './session';

/**
 * The M01 benchmark.
 *
 * Not a pass/fail gate — a measurement. It drives the same scripted tour over
 * boards of 1k, 10k and 100k items and writes what it saw to
 * `web/bench-results/`, machine and browser included, because a frame time
 * without the machine it was measured on is a number with no meaning.
 *
 * Run it deliberately: `pnpm --filter @visarium/web bench`.
 */

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results');

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

const BOARDS = [
  { name: 'small', items: 1_000 },
  { name: 'smoke', items: 10_000 },
  { name: 'large', items: 100_000 },
] as const;

async function tour(page: Page) {
  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.evaluate(() => window.__bench?.start());

  // 1. Sit still: the floor. Anything above zero here is work nobody asked for.
  await page.evaluate(() => window.__bench?.mark('idle'));
  await page.waitForTimeout(600);

  // 2. Pan across the dense cluster.
  await page.evaluate(() => window.__bench?.mark('pan'));
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx - i * 8, cy - i * 3);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');

  // 3. Zoom out to the whole board, then back in.
  await page.evaluate(() => window.__bench?.mark('zoom-out'));
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);

  await page.evaluate(() => window.__bench?.mark('zoom-in'));
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);

  // 4. Drag a selection: the pointer-to-pixel path.
  await page.evaluate(() => window.__bench?.mark('drag'));
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + i * 6, cy + i * 4);
  await page.mouse.up();

  return page.evaluate(() => window.__bench?.stop() as BenchReport);
}

for (const board of BOARDS) {
  test(`benchmark ${board.items} items`, async ({ page }) => {
    test.setTimeout(180_000);

    const start = Date.now();
    await page.goto(`/boards/${board.name}`);
    await expect(page.getByTestId('canvas-stats')).toBeVisible({ timeout: 60_000 });
    const navMs = Date.now() - start;

    const report = await tour(page);
    const stats = (await page.getByTestId('canvas-stats').textContent()) ?? '';

    mkdirSync(RESULTS, { recursive: true });
    const payload = { name: board.name, expectedItems: board.items, navMs, stats, ...report };
    writeFileSync(join(RESULTS, `${board.name}.json`), `${JSON.stringify(payload, null, 2)}\n`);

    console.log(`\n=== ${board.items} items ===`);
    console.log(JSON.stringify({ navMs, ...report }, null, 2));

    // The measurement must have happened. What it says is task 7's business.
    expect(report.board.items).toBe(board.items);
    expect(report.frameMsByPhase.pan?.count ?? 0).toBeGreaterThan(5);
  });
}
