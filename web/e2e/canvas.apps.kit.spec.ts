import { expect, type Page, test } from '@playwright/test';
import { call, fixture, idsOf, newBoard, SERVER, showBoard, xsrf } from './apps-server';

/**
 * The kit for visual apps (canvas/apps, openspec canvas-apps-live group 8),
 * against a real server: a chart fed by a note's table and a rack plan drawn
 * from its own JSON block, each live, as a card and in the background, with the
 * series in the board's chart palette in both themes.
 *
 * Run with `just e2e-apps`, which starts the server and sets VISARIUM_E2E_SERVER.
 * Screenshots land in test-results/ for a look in each theme.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

const table = (north: number) =>
  `# Sales\n\n| Quarter | North | South |\n| --- | --- | --- |\n| Q1 | ${north} | 80 |\n| Q2 | 150 | 95 |\n| Q3 | 170 | 110 |\n`;

type Snap = { items: { ref: string; output?: { version: number; card?: string | null } }[] };
async function outputOf(page: Page, board: string, ref: string) {
  const s = (await (
    await page.request.get(`${SERVER}/api/boards/${board}/snapshot`)
  ).json()) as Snap;
  return s.items.find((i) => i.ref === ref)?.output;
}

const view = (page: Page, id: string) =>
  page.frameLocator(`[data-testid="app-view"][data-item-id="${id}"] iframe`);

/** What the board's own chart token resolves to as a fill, in this page's theme. */
const boardSeries = (page: Page, n: number) =>
  page.evaluate((k) => {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    probe.style.fill = `var(--color-series-${k})`;
    svg.append(probe);
    document.body.append(svg);
    const fill = getComputedStyle(probe).fill;
    svg.remove();
    return fill;
  }, n);

async function seriesInBoardColours(page: Page, sales: string) {
  for (const n of [1, 2]) {
    const fill = await view(page, sales)
      .locator(`rect.series-${n}`)
      .first()
      .evaluate((r) => getComputedStyle(r).fill);
    expect(fill).toBe(await boardSeries(page, n));
  }
}

test('a chart and a rack plan run live, as cards and in the background, in the board colours', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'Kit');
  const b = { board };
  await call(request, 'item_create', { ...b, kind: 'note', source: table(120) });
  await call(request, 'app_create', {
    ...b,
    title: 'Sales',
    html: fixture('sales'),
    right_of: 'n1',
  });
  await call(request, 'link', { ...b, from: 'n1', to: 'a1', type: 'feeds', view: 'tables' });
  const id = await idsOf(page, board);

  // Live: the chart draws the note's table in the board's series colours.
  await showBoard(page, board, [id('n1'), id('a1')]);
  await expect(view(page, id('a1')).locator('rect.series-1')).toHaveCount(3, { timeout: 15_000 });
  await expect(view(page, id('a1')).locator('.legend li')).toHaveText(['North', 'South']);
  await seriesInBoardColours(page, id('a1'));
  await expect.poll(async () => (await outputOf(page, board, 'a1'))?.version).toBe(1);

  // At rest: zoomed out, its card is the chart it last drew.
  await page.mouse.move(40, 400);
  await page.mouse.wheel(0, 1600);
  await expect(page.getByTestId('app-view')).toHaveCount(0);
  await expect
    .poll(async () => (await outputOf(page, board, 'a1'))?.card ?? '', { timeout: 10_000 })
    .toContain('series-1');

  // In the background: a new rack plan nobody shows runs hidden, and an edit to
  // the table re-runs the chart hidden, each leaving its picture.
  await call(request, 'app_create', {
    ...b,
    title: 'Rack',
    html: fixture('rack'),
    below: 'a1',
  });
  await expect
    .poll(async () => (await outputOf(page, board, 'a2'))?.card ?? '', { timeout: 20_000 })
    .toContain('Rack A1');
  expect(await call(request, 'item_read', { ...b, ref: 'a2' })).toContain('free');
  const posted = await request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers: await xsrf(page),
    data: {
      operations: [
        {
          operationId: crypto.randomUUID(),
          baseRevision: 0,
          body: { type: 'item.source', itemId: id('n1'), source: table(200) },
        },
      ],
    },
  });
  expect(posted.ok(), await posted.text()).toBe(true);
  await expect
    .poll(async () => (await outputOf(page, board, 'a1'))?.version, { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(async () => (await outputOf(page, board, 'a1'))?.card ?? '', { timeout: 10_000 })
    .toContain('200');
  await expect(page.getByTestId('app-view')).toHaveCount(0);
  expect(await call(request, 'item_read', { ...b, ref: 'a1' })).toContain('North 520');

  // Both live again, in dark and then in light.
  const id2 = await idsOf(page, board);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => localStorage.setItem('visarium.theme', t), theme);
    await showBoard(page, board, [id2('n1'), id2('a1'), id2('a2')]);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(view(page, id2('a2')).locator('svg rect[class^="series-"]')).toHaveCount(6, {
      timeout: 15_000,
    });
    await expect(view(page, id2('a1')).locator('rect.series-1')).toHaveCount(3);
    await expect(view(page, id2('a1')).locator('#chart')).toBeVisible();
    await seriesInBoardColours(page, id2('a1'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath(`kit-${theme}.png`) });
  }
});
