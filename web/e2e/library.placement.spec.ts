import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * An asset in the library becoming an item on a board.
 *
 * The API is stubbed, for the reason the capture spec gives: what has no
 * unit-test equivalent here is the browser half — a real HTML5 drag carrying a
 * private MIME type, a real drop on the canvas, and the claim that one gesture
 * is one undo press. The sizing arithmetic is `capture.test.ts`; the server half
 * is `BoardOperationsIT`.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f32db';
const ASSET_DRAG_TYPE = 'application/x-visarium-assets';

interface Posted {
  readonly type: string;
  readonly content?: { kind: string; asset?: { assetId: string } };
}

function libraryOf(size: number) {
  return Array.from({ length: size }, (_, index) => ({
    id: `01a01640-6b72-7d60-968b-${String(index).padStart(12, '0')}`,
    mimeType: 'image/png',
    byteSize: 1024,
    width: 1600,
    height: 1200,
    originalFilename: `ref-${index}.png`,
  }));
}

/**
 * A board, a library, and a record of everything the client posted or uploaded.
 *
 * `uploads` is the one that carries a claim: placement must not enqueue one.
 */
async function stubApi(page: Page, options: { library?: number } = {}) {
  const bytes = readFileSync(FIXTURE);
  const assets = libraryOf(options.library ?? 40);
  const posted: Posted[] = [];
  const uploads: string[] = [];

  await page.route(
    (url) => url.pathname === '/api/collections',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route(
    (url) => url.pathname === '/api/assets',
    async (route) => {
      if (route.request().method() !== 'GET') {
        uploads.push(route.request().url());
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: assets[0]?.id, width: 512, height: 512, byteSize: 1 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assets }),
      });
    },
  );

  await page.route(
    (url) => url.pathname.startsWith('/api/assets/'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );

  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: 0, items: [], groups: [] }),
    }),
  );

  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Posted }[] };
    for (const operation of body.operations) posted.push(operation.body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: posted.length }),
    });
  });

  return { assets, posted, uploads };
}

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function itemCount(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
}

/** A real drag from the library: a DataTransfer carrying the private type. */
async function dropAssets(
  page: Page,
  ids: readonly string[],
  at: { x: number; y: number },
  target = 'canvas',
) {
  const transfer = await page.evaluateHandle(
    ([type, payload]) => {
      const dt = new DataTransfer();
      dt.setData(type as string, payload as string);
      return dt;
    },
    [
      ASSET_DRAG_TYPE,
      JSON.stringify(ids.map((assetId) => ({ assetId, width: 1600, height: 1200 }))),
    ] as const,
  );

  await page.dispatchEvent(target, 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent(target, 'drop', {
    dataTransfer: transfer,
    clientX: at.x,
    clientY: at.y,
  });
}

const panel = (page: Page) => page.getByRole('region', { name: 'Library' });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a dropped asset becomes an item without an upload or a placeholder', async ({ page }) => {
  const api = await stubApi(page);
  const centre = await openBoard(page);
  const before = await itemCount(page);

  await dropAssets(page, [api.assets[0]?.id ?? ''], centre);

  await expect(async () => expect(await itemCount(page)).toBe(before + 1)).toPass();
  await expect(async () => expect(api.posted).toHaveLength(1)).toPass();
  expect(api.posted[0]).toMatchObject({
    type: 'item.create',
    content: { kind: 'image', asset: { assetId: api.assets[0]?.id } },
  });
  // The whole point of placement: the bytes are already on the server.
  expect(api.uploads).toHaveLength(0);
});

test('eight placed assets are one undo press, and one redo', async ({ page }) => {
  const api = await stubApi(page);
  const centre = await openBoard(page);
  const before = await itemCount(page);
  const eight = api.assets.slice(0, 8).map((asset) => asset.id);

  await dropAssets(page, eight, centre);
  await expect(async () => expect(await itemCount(page)).toBe(before + 8)).toPass();

  await page.keyboard.press('Control+z');
  await expect(async () => expect(await itemCount(page)).toBe(before)).toPass();

  await page.keyboard.press('Control+Shift+z');
  await expect(async () => expect(await itemCount(page)).toBe(before + 8)).toPass();
});

test('a drag released outside the canvas creates nothing', async ({ page }) => {
  const api = await stubApi(page);
  await openBoard(page);
  const before = await itemCount(page);

  const box = await panel(page).boundingBox();
  if (!box) throw new Error('no panel');
  await dropAssets(
    page,
    [api.assets[0]?.id ?? ''],
    { x: box.x + 10, y: box.y + 10 },
    '[data-testid="library-scroller"]',
  );

  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  expect(await itemCount(page)).toBe(before);
});

test('clicking a thumbnail in the panel places it on the open board', async ({ page }) => {
  const api = await stubApi(page);
  await openBoard(page);
  const before = await itemCount(page);

  await panel(page).locator('li button').first().click();

  await expect(async () => expect(await itemCount(page)).toBe(before + 1)).toPass();
  expect(api.uploads).toHaveLength(0);
});

test('the panel filters without rewriting the board address', async ({ page }) => {
  await stubApi(page);
  await openBoard(page);
  const url = page.url();

  await panel(page).getByRole('searchbox', { name: 'Search the library' }).fill('ref-3');
  await expect(panel(page).locator('li').first()).toBeVisible();

  // The board route's URL is the board. A sidebar filter is not something
  // anyone sends to a colleague, so it stays out of it.
  expect(page.url()).toBe(url);
});

test('the grid in the sidebar is the same grid, at the density the panel asked for', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/derivatives/')) requested.push(path);
  });
  await stubApi(page, { library: 400 });
  await openBoard(page);
  await expect(panel(page).locator('li').first()).toBeVisible();

  // Windowed exactly as the full route is — the grid does not learn which
  // parent mounted it, it only reads the cell size and the measured container.
  expect(await panel(page).locator('li').count()).toBeLessThan(60);
  // And a smaller cell asks the ladder for a smaller tier, for free.
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every((path) => /\/derivatives\/(64|128|256)$/.test(path))).toBe(true);
});
