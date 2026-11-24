import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { canvasBox, signedIn } from './session';

/**
 * Dropping an image onto a board.
 *
 * The API is stubbed rather than run: what has no unit-test equivalent here is
 * the browser half — a real DataTransfer, a real decode, a real object URL, and
 * an item that exists before the request finishes. The server half is covered by
 * AssetUploadIT and by the ingest tests beside it.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f32db';

async function stubAssetApi(page: Page, options: { failUpload?: boolean } = {}) {
  const bytes = readFileSync(FIXTURE);

  await page.route('**/api/assets', async (route) => {
    if (options.failUpload) {
      await route.fulfill({ status: 507, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: ASSET_ID,
        mimeType: 'image/png',
        byteSize: bytes.length,
        width: 512,
        height: 512,
        originalFilename: 'dropped.png',
      }),
    });
  });

  await page.route('**/api/assets/*/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
  });
}

/** A real drop: a DataTransfer built in the page, carrying real bytes. */
async function dropImage(page: Page, at: { x: number; y: number }, name = 'dropped.png') {
  const bytes = [...readFileSync(FIXTURE)];
  const transfer = await page.evaluateHandle(
    async ([data, filename]) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array(data as number[])], filename as string, { type: 'image/png' }),
      );
      return dt;
    },
    [bytes, name] as const,
  );

  await page.dispatchEvent('canvas', 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'drop', {
    dataTransfer: transfer,
    clientX: at.x,
    clientY: at.y,
  });
}

async function itemCount(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
}

async function openBoard(page: Page) {
  await page.goto('/boards/small');
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await canvasBox(page);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a dropped image is on the board', async ({ page }) => {
  await stubAssetApi(page);
  const centre = await openBoard(page);
  const before = await itemCount(page);

  await dropImage(page, centre);

  await expect.poll(() => itemCount(page)).toBe(before + 1);
});

test('the item appears before the upload finishes', async ({ page }) => {
  const bytes = readFileSync(FIXTURE);
  let release: (() => void) | undefined;
  await page.route('**/api/assets', async (route) => {
    await new Promise<void>((resume) => {
      release = resume;
    });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: ASSET_ID, width: 512, height: 512, byteSize: bytes.length }),
    });
  });
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );

  const centre = await openBoard(page);
  const before = await itemCount(page);

  await dropImage(page, centre);

  // No dialog, no waiting: the item is there while the request is still open.
  await expect.poll(() => itemCount(page)).toBe(before + 1);
  await expect(page.getByTestId('upload-status')).toBeVisible();

  // The strip goes active when the job starts, which is before the request has
  // reached the route handler — so wait for the handler rather than racing it.
  await expect.poll(() => Boolean(release)).toBe(true);
  release?.();
  await expect(page.getByTestId('upload-status')).toBeHidden();
});

test('a failed upload keeps the item and says so', async ({ page }) => {
  await stubAssetApi(page, { failUpload: true });
  const centre = await openBoard(page);
  const before = await itemCount(page);

  await dropImage(page, centre);

  await expect(page.getByTestId('upload-failures')).toBeVisible({ timeout: 15_000 });
  expect(await itemCount(page)).toBe(before + 1);

  // Routine success is silent; a failure is acknowledged, not faded away.
  await page.getByTestId('upload-failures').click();
  await expect(page.getByTestId('upload-failures')).toBeHidden();
});

test('dropping is undoable like any other change', async ({ page }) => {
  await stubAssetApi(page);
  const centre = await openBoard(page);
  const before = await itemCount(page);

  await dropImage(page, centre);
  await expect.poll(() => itemCount(page)).toBe(before + 1);

  await page.keyboard.press('Control+z');
  await expect.poll(() => itemCount(page)).toBe(before);
});
