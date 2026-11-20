import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Quick search on the board (canvas/quick-search) and the shortcut legend
 * (canvas/shortcut-legend).
 *
 * Word rectangles need real layout, so they are read here, in a real engine,
 * through the dev server's `window.__objects.search` hook.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f5100';
const id = (n: number) => `01a01640-6b72-7d60-968b-88be186f51${String(n).padStart(2, '0')}`;
const NOTE = id(1);
const LIST = id(2);
const FLOW = id(3);
const NARROW = id(4);
const SCALED = id(5);

function item(itemId: string, x: number, y: number, content: object, extra: object = {}) {
  return {
    id: itemId,
    transform: { x, y, width: 320, height: 120, rotation: 0 },
    z: 1,
    revision: 0,
    content,
    ...extra,
  };
}

const ITEMS = [
  item(NOTE, -300, -200, { kind: 'note', source: 'Auth server calls the **auth** cache.' }),
  item(LIST, 100, -200, {
    kind: 'checklist',
    title: 'Auth work',
    tasks: [{ id: 't1', text: 'Ship the auth bar', state: 'todo' }],
  }),
  item(FLOW, -300, 0, {
    kind: 'diagram',
    lang: 'mermaid',
    source: 'graph TD\n  A[Auth Server] --> B[Token cache]',
  }),
  // Everything in the first viewport, so all of it is laid out. So narrow the phrase has to wrap across two lines.
  {
    ...item(NARROW, 150, 0, { kind: 'note', source: 'xx authentication service' }),
    transform: { x: 150, y: 0, width: 90, height: 120, rotation: 0 },
  },
  item(
    SCALED,
    -300,
    200,
    { kind: 'note', source: 'Auth server calls the **auth** cache.' },
    { textScale: 2 },
  ),
];

async function open(page: Page) {
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: { revision: 1, items: ITEMS, groups: [], links: [], people: {} } }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: unknown }[] };
    await route.fulfill({ json: { revision: 2, operations: body.operations.map((o) => o.body) } });
  });
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
}

type Found = { text: string; rects: { width: number; height: number; y: number }[][] };

async function found(page: Page, itemId: string, query: string): Promise<Found> {
  const handle = await page.waitForFunction(
    ([i, q]) =>
      (
        window as unknown as { __objects?: { search(id: string, q: string): unknown } }
      ).__objects?.search(i as string, q as string),
    [itemId, query],
    { timeout: 30_000 },
  );
  return (await handle.jsonValue()) as Found;
}

const count = (text: string, q: string) => text.toLowerCase().split(q.toLowerCase()).length - 1;

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('every counted occurrence is one that can be highlighted', async ({ page }) => {
  await open(page);
  for (const itemId of [NOTE, LIST, FLOW]) {
    const { text, rects } = await found(page, itemId, 'auth');
    expect(count(text, 'auth')).toBeGreaterThan(0);
    expect(rects).toHaveLength(count(text, 'auth'));
    for (const parts of rects) expect(parts.length).toBeGreaterThan(0);
  }
  // The diagram's text is its labels, not its syntax.
  expect(count((await found(page, FLOW, 'graph')).text, 'graph')).toBe(0);
});

test('an occurrence that wraps is highlighted on each line', async ({ page }) => {
  await open(page);
  const { rects } = await found(page, NARROW, 'xx authentication');
  expect(rects).toHaveLength(1);
  // One box per drawn line, each on its own line.
  const tops = (rects[0] ?? []).map((r) => Math.round(r.y));
  expect(tops.length).toBeGreaterThanOrEqual(2);
  expect(new Set(tops).size).toBe(tops.length);
});

test('Space opens search, Enter steps, Esc selects the result', async ({ page }) => {
  await open(page);
  await found(page, NOTE, 'auth');
  await page.keyboard.press('Space');
  const field = page.getByRole('searchbox', { name: 'Search the board' });
  await expect(field).toBeFocused();
  await field.fill('auth');
  const counter = page.getByTestId('canvas-search-count');
  await expect(counter).toHaveText(/^1 \/ \d+$/);
  const total = Number((await counter.textContent())?.split('/')[1]);
  expect(total).toBeGreaterThanOrEqual(6);
  await field.press('Enter');
  await expect(counter).toHaveText(`2 / ${total}`);
  await field.press('Shift+Enter');
  await field.press('Shift+Enter');
  await expect(counter).toHaveText(`${total} / ${total}`);
  await field.press('Enter');
  await expect(counter).toHaveText(`1 / ${total}`);
  // Words are highlighted on the board, the current one more strongly.
  const marks = await page.evaluate(() => {
    const stage = (window as unknown as { Konva?: { stages: { find(s: string): unknown[] }[] } })
      .Konva?.stages[0];
    return stage
      ? {
          words: stage.find('.search-word').length,
          current: stage.find('.search-word-current').length,
        }
      : undefined;
  });
  expect(marks?.current).toBe(1);
  expect(marks?.words ?? 0).toBeGreaterThan(0);
  await field.press('Escape');
  await expect(page.getByTestId('canvas-search')).toHaveCount(0);
  await expect(page.getByTestId('canvas-stats')).toContainText('1 selected');
});

test('holding Space to pan does not open search', async ({ page }) => {
  await open(page);
  const box = await page.getByTestId('canvas-stats').locator('..').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.keyboard.down('Space');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 240, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect(page.getByTestId('canvas-search')).toHaveCount(0);
});

test('Cmd/Ctrl+F opens search instead of the browser find', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.getByRole('searchbox', { name: 'Search the board' })).toBeFocused();
});

test('a text-scaled note scales its highlights with its text', async ({ page }) => {
  await open(page);
  await found(page, SCALED, 'auth');
  await page.keyboard.press('ControlOrMeta+f');
  const field = page.getByRole('searchbox', { name: 'Search the board' });
  await field.fill('calls the');
  const counter = page.getByTestId('canvas-search-count');
  await expect(counter).toHaveText('1 / 2');
  // Each result fits its own note; the current highlight is measured in
  // board units, so the camera's zoom does not enter into it.
  const current = () =>
    page.waitForFunction(() => {
      type Node = { getClientRect(o: { relativeTo: unknown }): { height: number } };
      const stage = (window as unknown as { Konva?: { stages: { find(s: string): Node[] }[] } })
        .Konva?.stages[0];
      const node = stage?.find('.search-word-current')[0];
      return node ? node.getClientRect({ relativeTo: stage }).height : undefined;
    });
  const first = Number(await (await current()).jsonValue());
  await field.press('Enter');
  await expect(counter).toHaveText('2 / 2');
  await page.waitForTimeout(100);
  const second = Number(await (await current()).jsonValue());
  const [a, b] = [Math.min(first, second), Math.max(first, second)];
  expect(b / a).toBeCloseTo(2, 0);
});

test('the shortcut legend shows in the corner and Settings turns it off', async ({ page }) => {
  await open(page);
  const legend = page.getByTestId('shortcut-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Search');
  await expect(legend).toHaveCSS('pointer-events', 'none');
  await page.goto('/settings');
  const toggle = page.getByTestId('shortcut-legend-setting').getByRole('checkbox');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await open(page);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await expect(legend).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await expect(legend).toHaveCount(0);
});
