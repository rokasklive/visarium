import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Collision (canvas/collision), from the browser's side: the toolbar toggle
 * goes out as one batch, survives a reload and undoes in one step, and a push
 * the server appends to a batch moves the pushed item on the author's own
 * board. The solver itself is `collision.rs`; the server half is `api.rs`.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f7c00';
const NOTE = '01a01640-6b72-7d60-968b-88be186f7c01';
const OTHER = '01a01640-6b72-7d60-968b-88be186f7c02';

interface Posted {
  readonly type: string;
  readonly itemId?: string;
  readonly collides?: boolean;
  readonly transform?: { x: number; y: number; width: number; height: number; rotation: number };
}

function note(id: string, x: number, y = 0) {
  return {
    id,
    transform: { x, y, width: 300, height: 120, rotation: 0 },
    z: 1,
    revision: 0,
    content: { kind: 'note', source: 'A note' },
  };
}

/**
 * A board that applies what it is sent, so a reload shows the result. When a
 * transform lands on NOTE, it answers as the server would with collision on:
 * the batch, then a push moving OTHER aside.
 */
async function stubBoard(page: Page, items: Record<string, unknown>[], pushOther = false) {
  const posted: Posted[] = [];
  const board = new Map(items.map((item) => [item.id as string, { ...item }]));
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: { revision: posted.length, items: [...board.values()], groups: [], links: [] },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Posted }[] };
    const applied: Posted[] = body.operations.map((o) => o.body);
    for (const op of applied) {
      posted.push(op);
      const item = op.itemId ? board.get(op.itemId) : undefined;
      if (op.type === 'item.collides' && item) item.collides = op.collides;
      if (op.type === 'item.transform' && item) item.transform = op.transform;
    }
    if (pushOther && applied.some((op) => op.type === 'item.transform' && op.itemId === NOTE)) {
      const push = {
        type: 'item.transform',
        itemId: OTHER,
        transform: { x: 450, y: 200, width: 300, height: 120, rotation: 0 },
      };
      applied.push(push);
      posted.push(push);
    }
    await route.fulfill({ json: { revision: posted.length, operations: applied } });
  });
  return posted;
}

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  // A note has no background: it is hit on its text, at its top left. The
  // camera starts at the world origin, where NOTE's centre is.
  return { x: box.x + box.width / 2 - 150 + 24, y: box.y + box.height / 2 - 60 + 14 };
}

const collision = (page: Page) => page.getByRole('button', { name: 'Collision', exact: true });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('collision toggles on in one batch, survives a reload, and undoes', async ({ page }) => {
  const posted = await stubBoard(page, [note(NOTE, 0)]);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  await expect(collision(page)).not.toHaveAttribute('aria-pressed', 'true');

  await collision(page).click();
  await expect(collision(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => posted.filter((op) => op.type === 'item.collides').length).toBe(1);
  expect(posted.at(-1)).toEqual({ type: 'item.collides', itemId: NOTE, collides: true });
  await expect(page.getByText(/saving/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await page.mouse.click(c.x, c.y);
  await expect(collision(page)).toHaveAttribute('aria-pressed', 'true');

  // Undo after the reload has nothing of ours to undo; toggle and undo instead.
  await collision(page).click();
  await expect(collision(page)).not.toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z');
  await expect(collision(page)).toHaveAttribute('aria-pressed', 'true');
});

test('a push the server appends moves the pushed item on the author’s board', async ({ page }) => {
  // Both stay on screen: an item outside the viewport has no node to ease.
  await stubBoard(page, [note(NOTE, 0), note(OTHER, 300, 200)], true);
  const c = await openBoard(page);
  await page.mouse.click(c.x, c.y);
  // Every drawn x of OTHER's node, frame by frame, while the push lands.
  await page.evaluate((id) => {
    const w = window as unknown as {
      Konva: { stages: { findOne(s: string): { x(): number } | undefined }[] };
      __xs: number[];
    };
    w.__xs = [];
    const sample = () => {
      const x = w.Konva.stages[0]?.findOne(`#${id}`)?.x();
      if (x !== undefined) w.__xs.push(x);
      if (w.__xs.length < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, OTHER);
  // Nudge NOTE: the stubbed server answers with a push of OTHER.
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window as unknown as { __objects: { item(id: string): { transform: { x: number } } } }
          ).__objects.item(id).transform.x,
        OTHER,
      ),
    )
    .toBe(450);
  // Eased, not jumped: it is drawn in between on the way, and arrives.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __xs: number[] }).__xs.at(-1)))
    .toBe(450);
  const xs = await page.evaluate(() => (window as unknown as { __xs: number[] }).__xs);
  expect(xs.some((x) => x > 300 && x < 450)).toBe(true);
});

const DIAGRAM = '01a01640-6b72-7d60-968b-88be186f7c03';

test('a laid-out diagram reports its element boxes once per revision', async ({ page }) => {
  await stubBoard(page, [
    {
      id: DIAGRAM,
      transform: { x: 0, y: 0, width: 480, height: 200, rotation: 0 },
      z: 1,
      revision: 0,
      content: { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  A[Start] --> B[End]' },
    },
  ]);
  const reports: { revision: number; elements: Record<string, number[]> }[] = [];
  await page.route(`**/api/boards/${BOARD}/items/${DIAGRAM}/elements`, async (route) => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await openBoard(page);
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]?.revision).toBe(0);
  expect(Object.keys(reports[0]?.elements ?? {}).sort()).toEqual(['A', 'B']);

  // A move re-uses the layout: no new report.
  await page.evaluate((id) => {
    const w = window as unknown as { __objects: { apply(...b: unknown[]): void } };
    w.__objects.apply({
      type: 'item.transform',
      itemId: id,
      transform: { x: 40, y: 0, width: 480, height: 200, rotation: 0 },
    });
  }, DIAGRAM);
  // An edit is a new revision, and a new report.
  await page.evaluate((id) => {
    const w = window as unknown as { __objects: { apply(...b: unknown[]): void } };
    w.__objects.apply({
      type: 'item.source',
      itemId: id,
      source: 'flowchart LR\n  A[Start] --> C[Middle]',
    });
  }, DIAGRAM);
  await expect.poll(() => reports.length).toBe(2);
  expect(Object.keys(reports[1]?.elements ?? {}).sort()).toEqual(['A', 'C']);
  expect(reports[1]?.revision).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(reports).toHaveLength(2);
});

test('an agent’s note gets its drawn height from a browser that did not write it', async ({
  page,
}) => {
  const tall = { ...note(NOTE, 0), collides: true };
  tall.transform = { ...tall.transform, height: 600 };
  const fixed = { ...note(OTHER, 400), collides: false };
  fixed.transform = { ...fixed.transform, height: 600 };
  const posted = await stubBoard(page, [tall, fixed]);
  await openBoard(page);
  await expect
    .poll(() => posted.filter((op) => op.type === 'item.transform' && op.itemId === NOTE).length)
    .toBe(1);
  expect(posted.find((op) => op.itemId === NOTE)?.transform?.height).toBeLessThan(600);
  await page.waitForTimeout(500);
  expect(posted.some((op) => op.itemId === OTHER)).toBe(false);
});
