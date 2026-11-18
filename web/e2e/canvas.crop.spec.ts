import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Non-destructive crop (ADR-0029), from the browser's side.
 *
 * The geometry is `crop.test.ts` and the server is `api.rs`; what only a real
 * browser can show is that the gestures reach the right operation: that Ctrl+Alt
 * on a real Transformer handle crops one edge even though Konva centres the box
 * under Alt, that crop mode is entered and left by its keys, and that the result
 * goes out as ONE `item.transform` carrying both box and crop.
 *
 * The board sits at the world origin and the camera starts there at zoom 1, so
 * the item's handles are at the canvas centre ± half its size.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-1.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f3c00';
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f3c01';
const ITEM = '01a01640-6b72-7d60-968b-88be186f3c02';
const OTHER = '01a01640-6b72-7d60-968b-88be186f3c03';
const SIZE = 300;
const HALF = SIZE / 2;

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Posted {
  readonly type: string;
  readonly itemId?: string;
  readonly transform?: { x: number; y: number; width: number; height: number };
  readonly crop?: Crop;
}

function image(id: string, over: { x?: number; width?: number; crop?: Crop } = {}) {
  return {
    id,
    transform: { x: over.x ?? 0, y: 0, width: over.width ?? SIZE, height: SIZE, rotation: 0 },
    z: 1,
    content: {
      kind: 'image',
      asset: { assetId: ASSET_ID, intrinsicWidth: 512, intrinsicHeight: 512 },
    },
    ...(over.crop ? { crop: over.crop } : {}),
  };
}

/** A board that applies what it is sent, so a reload shows the result. */
async function stubBoard(page: Page, items: Record<string, unknown>[]) {
  const posted: Posted[] = [];
  const board = new Map(items.map((item) => [item.id as string, { ...item }]));
  const bytes = readFileSync(FIXTURE);

  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: { revision: posted.length, items: [...board.values()], groups: [] } }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Posted }[] };
    for (const { body: op } of body.operations) {
      posted.push(op);
      const item = op.itemId ? board.get(op.itemId) : undefined;
      if (op.type === 'item.transform' && item) {
        item.transform = op.transform;
        if (op.crop) item.crop = op.crop;
      }
    }
    await route.fulfill({ json: { revision: posted.length } });
  });
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );
  return posted;
}

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** The last crop that went to the server, once it has. */
async function lastCrop(posted: Posted[]) {
  await expect.poll(() => posted.filter((op) => op.crop).length).toBeGreaterThan(0);
  return posted.filter((op) => op.crop).at(-1) as Required<Pick<Posted, 'crop' | 'transform'>>;
}

const cropButton = (page: Page) => page.getByRole('button', { name: 'Crop', exact: true });
const ghost = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { Konva?: { stages: { findOne(s: string): unknown }[] } }
      ).Konva?.stages[0]?.findOne('#crop-ghost') !== undefined,
  );

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('Ctrl+Alt on a handle crops that edge and leaves the other still', async ({ page }) => {
  const posted = await stubBoard(page, [image(ITEM)]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);

  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await drag(page, { x: c.x - HALF, y: c.y }, { x: c.x - HALF + 100, y: c.y });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');

  const { crop, transform } = await lastCrop(posted);
  expect(crop.x).toBeCloseTo(1 / 3, 2);
  expect(crop.width).toBeCloseTo(2 / 3, 2);
  // Konva centres the box under Alt; the right edge must not have moved anyway.
  expect(transform.x + transform.width / 2).toBeCloseTo(HALF, 0);
  expect(transform.width).toBeCloseTo(SIZE - 100, 0);
  // One operation for the gesture, carrying both.
  expect(posted.filter((op) => op.type === 'item.transform')).toHaveLength(1);
});

test('C enters crop mode, Escape leaves it and keeps crop and selection', async ({ page }) => {
  const posted = await stubBoard(page, [image(ITEM)]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);

  await page.keyboard.press('c');
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await ghost(page)).toBe(true);
  await drag(page, { x: c.x + HALF, y: c.y }, { x: c.x + HALF - 100, y: c.y });
  const { crop } = await lastCrop(posted);
  expect(crop.width).toBeCloseTo(2 / 3, 2);

  await page.keyboard.press('Escape');
  await expect(cropButton(page)).not.toHaveAttribute('aria-pressed', 'true');
  expect(await ghost(page)).toBe(false);
  await expect(page.getByTestId('canvas-stats')).toContainText('1 selected');
});

test('double-click enters crop mode', async ({ page }) => {
  await stubBoard(page, [image(ITEM)]);
  const c = await openBoard(page);
  await page.mouse.dblclick(c.x, c.y);
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'true');
});

test('un-cropping past the original stops at its edge', async ({ page }) => {
  // The left half of the original showing: left edge at -150, right at 0.
  const half = { x: 0, y: 0, width: 0.5, height: 1 };
  const posted = await stubBoard(page, [image(ITEM, { x: -HALF / 2, width: HALF, crop: half })]);
  const c = await openBoard(page);
  await page.mouse.click(c.x - HALF / 2, c.y);
  await page.keyboard.press('c');

  await drag(page, { x: c.x, y: c.y }, { x: c.x + 400, y: c.y });

  const { crop, transform } = await lastCrop(posted);
  expect(crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  expect(transform.width).toBeCloseTo(SIZE, 0);
});

test('dragging inside a crop slides the image under a still window', async ({ page }) => {
  const window = { x: 0.25, y: 0, width: 0.5, height: 1 };
  const posted = await stubBoard(page, [image(ITEM, { width: HALF, crop: window })]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('c');

  await drag(page, { x: c.x, y: c.y }, { x: c.x + 30, y: c.y });

  const { crop, transform } = await lastCrop(posted);
  // Content followed the pointer 30 units right: the window moved 30/300 left.
  expect(crop.x).toBeCloseTo(0.15, 2);
  expect(transform.x).toBeCloseTo(0, 5);
});

test('a repeated pointer event mid-slide does not snap the image back', async ({ page }) => {
  // WebKit and trackpads send drag events at an unchanged position; Konva still
  // fires dragmove for them. The slide must read the same place, not zero.
  const window = { x: 0.25, y: 0, width: 0.5, height: 1 };
  await stubBoard(page, [image(ITEM, { width: HALF, crop: window })]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('c');
  const cropX = () =>
    page.evaluate(() => {
      const konva = (
        globalThis as unknown as {
          Konva: { stages: { find(s: string): { draggable(): boolean; cropX(): number }[] }[] };
        }
      ).Konva;
      return (
        konva.stages[0]
          ?.find('Image')
          .find((n) => n.draggable())
          ?.cropX() ?? Number.NaN
      );
    });

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y, { steps: 5 });
  const moved = await cropX();
  await page.evaluate(
    ({ x, y }) =>
      globalThis.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 1 })),
    { x: c.x + 30, y: c.y },
  );
  expect(await cropX()).toBeCloseTo(moved, 5);
  await page.mouse.up();
});

test('Reset crop shows the whole original, and undo is one step', async ({ page }) => {
  const posted = await stubBoard(page, [
    image(ITEM, { x: HALF / 2, width: HALF, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } }),
  ]);
  const c = await openBoard(page);
  await page.mouse.click(c.x + HALF / 2, c.y);

  await page.getByRole('button', { name: 'Reset crop' }).click();
  const reset = await lastCrop(posted);
  expect(reset.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  expect(reset.transform.x).toBeCloseTo(0, 5);
  expect(reset.transform.width).toBeCloseTo(SIZE, 5);

  await page.keyboard.press('Control+z');
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]?.crop).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  expect(posted[1]?.transform?.x).toBeCloseTo(HALF / 2, 5);
});

test('a crop survives a reload', async ({ page }) => {
  await stubBoard(page, [image(ITEM)]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('c');
  await drag(page, { x: c.x + HALF, y: c.y }, { x: c.x, y: c.y });
  await expect(page.getByRole('button', { name: 'Reset crop' })).toHaveAttribute(
    'title',
    'Show the whole original again',
  );
  // Let the batch reach the stub before the page that sent it goes away.
  await expect(page.getByText(/saving/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await page.mouse.click(c.x - HALF / 2, c.y);
  await expect(page.getByRole('button', { name: 'Reset crop' })).toHaveAttribute(
    'title',
    'Show the whole original again',
  );
});

test('with two images selected, Ctrl+Alt resizes and crops nothing', async ({ page }) => {
  const posted = await stubBoard(page, [image(ITEM), image(OTHER, { x: 400 })]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('canvas-stats')).toContainText('2 selected');
  await expect(cropButton(page)).toHaveAttribute('title', 'Select one image to crop it');

  // The selection's top-left corner is the first item's.
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await drag(page, { x: c.x - HALF, y: c.y - HALF }, { x: c.x - HALF + 60, y: c.y - HALF + 60 });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');

  await expect.poll(() => posted.length).toBeGreaterThan(0);
  expect(posted.every((op) => op.type === 'item.transform' && op.crop === undefined)).toBe(true);
});
