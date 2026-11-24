import { expect, type Page, test } from '@playwright/test';
import { canvasBox, signedIn } from './session';

/**
 * The canvas, driven the way a person drives it.
 *
 * Pointer capture during a drag, wheel zoom and marquee hit-testing have no
 * meaningful unit-test equivalent — they are browser behaviour, so they are
 * tested in a browser. See docs/development/TESTING.md.
 */

/** `10,000 items · 300 candidates · 280 rendered · 0 aggregated · 1 selected · 100%` */
async function stats(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  const n = (label: string) =>
    Number(new RegExp(`([\\d,]+) ${label}`).exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
  return {
    text,
    items: n('items'),
    candidates: n('candidates'),
    rendered: n('rendered'),
    aggregated: n('aggregated'),
    selected: n('selected'),
    truncated: text.includes('truncated'),
  };
}

async function openBoard(page: Page) {
  await page.goto('/boards/smoke');
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await canvasBox(page);
  return { box, centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
}

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('renders far fewer nodes than the document holds', async ({ page }) => {
  await openBoard(page);
  const s = await stats(page);

  expect(s.items).toBe(10_000);
  expect(s.rendered).toBeGreaterThan(0); // an empty viewport would pass any ceiling
  expect(s.rendered).toBeLessThan(600);
});

test('aggregates rather than dropping items when zoomed out', async ({ page }) => {
  const { centre } = await openBoard(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(300);

  const s = await stats(page);
  // Invariant 8: everything the viewport query returned is drawn as something.
  // Items outside the viewport are not "dropped" — they were never asked for.
  expect(s.rendered + s.aggregated).toBe(s.candidates);
  expect(s.aggregated).toBeGreaterThan(0);
  expect(s.rendered).toBeLessThanOrEqual(500);
});

test('wheel zooms the canvas and not the page', async ({ page }) => {
  const { centre } = await openBoard(page);
  const before = (await stats(page)).text;

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(100);

  expect((await stats(page)).text).not.toBe(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('clicking selects, clicking empty space clears', async ({ page }) => {
  const { centre } = await openBoard(page);
  await page.mouse.click(centre.x, centre.y);
  expect((await stats(page)).selected).toBeGreaterThan(0);

  // Zoom out far enough that the pointer lands between clusters.
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);
  await page.mouse.click(centre.x - 380, centre.y - 260);
  expect((await stats(page)).selected).toBe(0);
});

test('marquee selects what it covers', async ({ page }) => {
  const { centre } = await openBoard(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);

  await page.mouse.move(centre.x - 400, centre.y - 280);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 120, { steps: 12 });
  await page.mouse.up();

  expect((await stats(page)).selected).toBeGreaterThan(1);
});

test('a drag survives the pointer leaving the canvas, and undo puts it back', async ({ page }) => {
  const { box, centre } = await openBoard(page);
  await page.mouse.click(centre.x, centre.y);
  expect((await stats(page)).selected).toBe(1);

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 200, box.y - 40, { steps: 10 }); // above the canvas
  await page.mouse.move(centre.x + 200, centre.y + 150, { steps: 10 });
  await page.mouse.up();

  // The drag committed, so it can be taken back.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
});

test('grouping makes one click select the whole group', async ({ page }) => {
  const { centre } = await openBoard(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);

  await page.mouse.move(centre.x - 400, centre.y - 280);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 120, { steps: 12 });
  await page.mouse.up();
  const marqueed = (await stats(page)).selected;

  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.mouse.click(centre.x - 400, centre.y - 280); // empty: clear
  expect((await stats(page)).selected).toBe(0);

  await page.mouse.click(centre.x, centre.y); // one member
  expect((await stats(page)).selected).toBe(marqueed);
});

/**
 * Framing, select-all and escape — M07's missing keys.
 *
 * The arithmetic is `camera.test.ts`; what has no unit-test equivalent is that
 * the key reaches the canvas, that framing moves the camera and nothing else,
 * and that it costs nothing on a board nobody could iterate.
 */
test('F frames the whole board, and it is not an operation', async ({ page }) => {
  const { centre } = await openBoard(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  const zoomedIn = (await stats(page)).text;

  await page.keyboard.press('f');
  await page.waitForTimeout(150);

  expect((await stats(page)).text).not.toBe(zoomedIn);
  // The camera moved; the board did not. Nothing to undo.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});

test('F frames the selection when there is one', async ({ page }) => {
  const { centre } = await openBoard(page);

  // At the default zoom there is something under the pointer to select.
  await page.mouse.click(centre.x, centre.y);
  expect((await stats(page)).selected).toBeGreaterThan(0);
  const before = (await stats(page)).text;
  await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('title', /selection/);

  await page.keyboard.press('f');
  await page.waitForTimeout(150);

  // One item fills far more of the viewport than the board around it did.
  expect((await stats(page)).text).not.toBe(before);
  expect((await stats(page)).rendered).toBeLessThan(50);
});

/**
 * Framing everything reads the spatial index's root envelope — an O(1) value
 * RBush already maintains — rather than iterating the document.
 *
 * Serial and slow-marked because building a 100,000-item board saturates the
 * machine, and a parallel worker starved by it fails for a reason that has
 * nothing to do with framing.
 */
test.describe('framing at 100,000 items', () => {
  test.describe.configure({ mode: 'serial' });

  test('is instant, and the ceiling still holds afterwards', async ({ page }) => {
    test.slow();
    await page.goto('/boards/large');
    await expect(page.getByTestId('canvas-stats')).toBeVisible({ timeout: 30_000 });
    expect((await stats(page)).items).toBe(100_000);

    const started = Date.now();
    await page.keyboard.press('f');
    await page.waitForTimeout(150);

    expect(Date.now() - started).toBeLessThan(3_000);
    const s = await stats(page);
    expect(s.items).toBe(100_000);
    expect(s.rendered).toBeLessThanOrEqual(500);
  });
});

test('select all takes the board, and escape gives it back', async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  expect((await stats(page)).selected).toBe(10_000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect((await stats(page)).selected).toBe(0);
});

test('escape abandons a marquee rather than applying it', async ({ page }) => {
  const { box, centre } = await openBoard(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);

  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(100);

  expect((await stats(page)).selected).toBe(0);
});
