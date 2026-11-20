import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * The inspector (canvas/inspector), on the dev server: opened by backquote,
 * beside the board, showing the stored model, tables, the operation log, and a
 * console whose operations travel the board's own path. That the production
 * bundle has none of it is `scripts/check-bundle.mjs`, run by `just test`.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f8000';
const FLOW = '01a01640-6b72-7d60-968b-88be186f8001';
const NOTE = '01a01640-6b72-7d60-968b-88be186f8002';
const LIST = '01a01640-6b72-7d60-968b-88be186f8003';
const LINK = '01a01640-6b72-7d60-968b-88be186f8004';

const items = [
  {
    id: FLOW,
    transform: { x: 100, y: -120, width: 320, height: 100, rotation: 0 },
    z: 1,
    revision: 4,
    content: { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  API --> Pay' },
  },
  {
    id: NOTE,
    transform: { x: -220, y: -120, width: 200, height: 100, rotation: 0 },
    z: 1,
    revision: 0,
    content: { kind: 'note', source: '### Overview' },
  },
  {
    id: LIST,
    transform: { x: -220, y: 120, width: 200, height: 100, rotation: 0 },
    z: 1,
    revision: 0,
    content: {
      kind: 'checklist',
      title: 'Build',
      tasks: [{ id: 't1', text: 'Keys', state: 'todo' }],
    },
  },
];
const links = [
  {
    id: LINK,
    from: { itemId: NOTE, element: null },
    to: { itemId: FLOW, element: 'Pay' },
    linkType: 'describes',
  },
];

interface Op {
  type: string;
  [k: string]: unknown;
}

async function stubSocket(page: Page) {
  await page.addInitScript(() => {
    const control = { deliver: (_: unknown) => {}, opened: false };
    (window as unknown as { __socket: typeof control }).__socket = control;
    const Real = window.WebSocket;
    class Stub extends EventTarget {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(public url: string) {
        super();
        queueMicrotask(() => {
          control.opened = true;
          control.deliver = (f) => this.onmessage?.({ data: JSON.stringify(f) });
          this.onopen?.();
        });
      }
      send() {}
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = new Proxy(Real, {
      construct: (t, a: [string]) =>
        a[0].includes('/ws/canvas/')
          ? (new Stub(a[0]) as unknown as WebSocket)
          : Reflect.construct(t, a),
    });
  });
}

async function stubBoard(page: Page, reject?: { status: number; detail: string }) {
  const posted: Op[] = [];
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: { revision: 1, items, groups: [], links, people: {} } }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    if (reject) {
      await route.fulfill({
        status: reject.status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Stale edit', detail: reject.detail }),
      });
      return;
    }
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  return posted;
}

async function open(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  // Drawn, not just laid out: a click before the bitmap is on the hit canvas misses.
  await page.waitForFunction(
    (i) =>
      (
        window as unknown as {
          Konva: { stages: { findOne(s: string): { className: string } | undefined }[] };
        }
      ).Konva.stages[0]?.findOne(`#${i}`)?.className === 'Image',
    FLOW,
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

const inspector = (page: Page) => page.getByTestId('visarium-inspector');

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('backquote opens the inspector beside the board and closes it; a text field keeps its backquote', async ({
  page,
}) => {
  await stubBoard(page);
  await open(page);
  const before = (await page.locator('canvas').first().boundingBox())?.width ?? 0;

  await page.keyboard.press('Backquote');
  await expect(inspector(page)).toBeVisible();
  // Beside, not over: the board gives up the inspector's width.
  await expect
    .poll(async () => (await page.locator('canvas').first().boundingBox())?.width ?? 0)
    .toBeLessThan(before - 300);
  const panel = await inspector(page).boundingBox();
  const canvas = await page.locator('canvas').first().boundingBox();
  expect((canvas?.x ?? 0) + (canvas?.width ?? 0)).toBeLessThanOrEqual((panel?.x ?? 0) + 1);

  await page.keyboard.press('Backquote');
  await expect(inspector(page)).toHaveCount(0);

  // Typing a backquote into a note types it.
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.dblclick(box.x + box.width / 2 + 150, box.y + box.height / 2 + 200);
  await page.keyboard.type('code `x`');
  await expect(page.getByRole('textbox', { name: 'New note' })).toHaveValue('code `x`');
  await expect(inspector(page)).toHaveCount(0);
});

test("shows a selected diagram's stored model, its elements and links, and the board as tables", async ({
  page,
}) => {
  await stubBoard(page);
  await open(page);
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  // Clear of the link, which now runs straight across from the note at the
  // height the two share (canvas/link-geometry).
  await page.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2 - 130);
  await page.keyboard.press('Backquote');
  await expect(inspector(page)).toContainText('"lang": "mermaid"');
  await expect(inspector(page)).toContainText('"revision": 4');
  await expect(inspector(page)).toContainText('Pay 1 links');
  await expect(inspector(page)).toContainText('API 0 links');

  await inspector(page).getByRole('tab', { name: 'tables' }).click();
  await expect(page.getByTestId('inspector-items').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByTestId('inspector-links').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('inspector-links')).toContainText('Pay');
  await expect(page.getByTestId('inspector-links')).toContainText('describes');
});

test('the log says what the server refused, in its own words', async ({ page }) => {
  await stubBoard(page, {
    status: 409,
    detail: 'item changed since this edit began: revision 3 vs 4',
  });
  await open(page);
  await page.keyboard.press('Backquote');
  await inspector(page).getByRole('tab', { name: 'console' }).click();
  await inspector(page)
    .getByRole('textbox', { name: 'Operations as JSON' })
    .fill(
      JSON.stringify({ type: 'item.source', itemId: NOTE, source: '### Late', baseRevision: 3 }),
    );
  await inspector(page).getByRole('button', { name: 'Send' }).click();
  await inspector(page).getByRole('tab', { name: 'log' }).click();
  // The whole batch is refused, so the note's follow-up height write is too; the
  // source edit is the entry under test.
  const rejected = page
    .getByTestId('inspector-log')
    .locator('[data-outcome="rejected"]')
    .filter({ hasText: 'item.source' });
  await expect(rejected).toHaveCount(1, { timeout: 10_000 });
  await expect(rejected).toContainText('409: item changed since this edit began');
});

test('an operation sent from the console reaches a second viewer like any other', async ({
  browser,
}) => {
  // Two people on one board. The server between them is stubbed: what one posts
  // is delivered to the other as the broadcast frame the server sends.
  const make = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubSocket(page);
    await signedIn(page);
    const posted = await stubBoard(page);
    await open(page);
    await page.waitForFunction(
      () => (window as unknown as { __socket: { opened: boolean } }).__socket.opened,
    );
    await page.evaluate(() =>
      (window as unknown as { __socket: { deliver(f: unknown): void } }).__socket.deliver({
        t: 'welcome',
        actorId: crypto.randomUUID(),
        revision: 1,
        actors: [],
      }),
    );
    return { page, posted, context };
  };
  const ada = await make();
  const grace = await make();

  await ada.page.keyboard.press('Backquote');
  await inspector(ada.page).getByRole('tab', { name: 'console' }).click();
  await inspector(ada.page)
    .getByRole('textbox', { name: 'Operations as JSON' })
    .fill(JSON.stringify([{ type: 'task.set', itemId: LIST, taskId: 't1', state: 'done' }]));
  await inspector(ada.page).getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => ada.posted.filter((op) => op.type === 'task.set').length).toBe(1);

  const sent = ada.posted.filter((op) => op.type === 'task.set');
  await grace.page.evaluate(
    (operations) =>
      (window as unknown as { __socket: { deliver(f: unknown): void } }).__socket.deliver({
        t: 'op',
        fromRevision: 1,
        toRevision: 1 + operations.length,
        operations: operations.map((o) => ({
          ...o,
          by: '01a01640-6b72-7d60-968b-88be186f8099',
          at: new Date().toISOString(),
        })),
      }),
    sent,
  );
  await expect
    .poll(() =>
      grace.page.evaluate(
        (i) =>
          (
            window as unknown as {
              __objects: { item(id: string): { content: { tasks: { state: string }[] } } };
            }
          ).__objects.item(i).content.tasks[0]?.state,
        LIST,
      ),
    )
    .toBe('done');
  // And the second viewer's log shows it arriving.
  await grace.page.keyboard.press('Backquote');
  await inspector(grace.page).getByRole('tab', { name: 'log' }).click();
  await expect(
    grace.page.getByTestId('inspector-log').locator('[data-outcome="received"]').first(),
  ).toContainText('task.set');
  await ada.context.close();
  await grace.context.close();
});
