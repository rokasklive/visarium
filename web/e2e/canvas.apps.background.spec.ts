import { expect, type Page, test } from '@playwright/test';
import {
  call,
  dblclickItem,
  fixture,
  idsOf,
  newBoard,
  SERVER,
  showBoard,
  xsrf,
} from './apps-server';

/**
 * Stale apps run in the background (canvas/apps, openspec canvas-apps-live
 * group 6), against a real server: a client with the board open runs an app
 * it does not show in a hidden view, for an agent or for its own person.
 *
 * Run with `just e2e-apps`, which starts the server and sets VISARIUM_E2E_SERVER.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

type Snap = {
  items: {
    ref: string;
    output?: { version: number; card?: string | null; status: string; error?: string | null };
  }[];
};

async function outputOf(page: Page, board: string, ref: string) {
  const s = (await (
    await page.request.get(`${SERVER}/api/boards/${board}/snapshot`)
  ).json()) as Snap;
  return s.items.find((i) => i.ref === ref)?.output;
}

/** Zoomed out until no app is big enough to be live: every app is a card. */
async function zoomOut(page: Page) {
  await page.mouse.move(40, 400);
  await page.mouse.wheel(0, 1600);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('app-view')).toHaveCount(0);
}

test('an app nobody shows runs hidden in a client that has the board open', async ({ page }) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'Background');
  const b = { board };
  await call(request, 'item_create', { ...b, kind: 'note', source: '---\nage: 40\n---\n# Policy' });
  await call(request, 'app_create', {
    ...b,
    title: 'Premium',
    html: fixture('premium'),
    right_of: 'n1',
  });
  await call(request, 'link', { ...b, from: 'n1', to: 'a1', type: 'feeds', view: 'frontmatter' });
  // Nobody has the board open: nobody can run it.
  expect(await call(request, 'app_run', { ...b, ref: 'a1' })).toMatch(/^needs_viewer/);

  const id = await idsOf(page, board);
  await showBoard(page, board, [id('n1'), id('a1')]);
  await zoomOut(page);

  // Someone else's client: an agent runs a1, which is a card on this screen.
  let ran = '';
  for (let tries = 0; tries < 50 && !ran.includes('Ran a1.'); tries++) {
    ran = await call(request, 'app_run', { ...b, ref: 'a1' });
    if (!ran.includes('Ran a1.')) await page.waitForTimeout(200);
  }
  expect(ran).toContain('premium=1200');
  await expect(page.getByTestId('app-view')).toHaveCount(0);
  // Its hidden view left its picture behind, then went.
  await expect
    .poll(async () => (await outputOf(page, board, 'a1'))?.card ?? '', { timeout: 10_000 })
    .toContain('1200');
  await expect(page.getByTestId('app-hidden')).toHaveCount(0, { timeout: 10_000 });

  // Run without opening: the note changes, the person runs a1 from its inspector.
  const posted = await request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers: await xsrf(page),
    data: {
      operations: [
        {
          operationId: crypto.randomUUID(),
          baseRevision: 0,
          body: { type: 'item.source', itemId: id('n1'), source: '---\nage: 45\n---\n# Policy' },
        },
      ],
    },
  });
  expect(posted.ok(), await posted.text()).toBe(true);
  await dblclickItem(page, id('a1'));
  const inspector = page.getByTestId('app-inspector');
  await expect(inspector.getByTestId('output-status')).toHaveText(/^stale/);
  await inspector.getByTestId('inspector-run').click();
  await expect(inspector.getByTestId('output-status')).toHaveText('fresh', { timeout: 15_000 });
  await expect.poll(async () => (await outputOf(page, board, 'a1'))?.version).toBe(2);
  expect(await call(request, 'item_read', { ...b, ref: 'a1' })).toContain('premium');
});

test('a hidden run that never finishes ends in an error that says so', async ({ page }) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'Never');
  const b = { board };
  // An app that never answers the host: it never runs anything.
  await call(request, 'app_create', {
    ...b,
    title: 'Silent',
    html: '<!doctype html><html><body><p>silent</p></body></html>',
  });
  const id = await idsOf(page, board);
  await showBoard(page, board, [id('a1')]);
  await zoomOut(page);
  await dblclickItem(page, id('a1'));
  const inspector = page.getByTestId('app-inspector');
  await inspector.getByTestId('inspector-run').click();
  await expect(page.getByTestId('app-hidden')).toHaveCount(1);
  await expect
    .poll(async () => (await outputOf(page, board, 'a1'))?.error ?? '', { timeout: 45_000 })
    .toContain('did not finish in the background');
  await expect(inspector.getByTestId('output-status')).toHaveText('error');
  await expect(page.getByTestId('app-hidden')).toHaveCount(0, { timeout: 10_000 });
});
