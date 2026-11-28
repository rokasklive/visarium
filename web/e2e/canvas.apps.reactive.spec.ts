import { expect, test } from '@playwright/test';
import { call, fixture, idsOf, newBoard, SERVER, showBoard, xsrf } from './apps-server';

/**
 * Apps run automatically (canvas/apps, openspec canvas-apps-live group 7),
 * against a real server: the reduced insurance chain, note → a1 → a2 → c1,
 * repairs itself after an edit with nobody pressing Run and no agent asking.
 *
 * Run with `just e2e-apps`, which starts the server and sets VISARIUM_E2E_SERVER.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

test('an edit to the note runs the whole chain on its own, credited to the edit', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'Reactive');
  const b = { board };
  await call(request, 'item_create', {
    ...b,
    kind: 'note',
    source: '---\nage: 40\nexpected_premium: 1200\n---\n# Policy quote',
  });
  await call(request, 'item_create', {
    ...b,
    kind: 'checklist',
    title: 'Underwriting',
    tasks: ['Premium matches the quote'],
    below: 'n1',
  });
  await call(request, 'app_create', {
    ...b,
    title: 'Premium',
    html: fixture('premium'),
    right_of: 'n1',
  });
  await call(request, 'app_create', {
    ...b,
    title: 'Expected vs actual',
    html: fixture('comparison'),
    right_of: 'a1',
    link: { type: 'updates', to: 'c1' },
  });
  await call(request, 'link', { ...b, from: 'n1', to: 'a1', type: 'feeds', view: 'frontmatter' });
  await call(request, 'link', { ...b, from: 'a1', to: 'a2', type: 'feeds', view: 'outputs' });
  const id = await idsOf(page, board);

  // The person opens the board: what never ran runs, a1 then a2.
  await showBoard(page, board, [id('n1'), id('c1'), id('a1'), id('a2')]);
  const overview = () => call(request, 'board_read', b);
  await expect
    .poll(overview, { timeout: 20_000 })
    .toMatch(/a2 +app "Expected vs actual" · fresh · v1/);
  expect(await overview()).toMatch(/a1 +app "Premium" · fresh · v1/);
  expect(await call(request, 'item_read', { ...b, ref: 'c1' })).toMatch(/c1\/t1 \[done\]/);

  // The person edits the note; nobody runs anything.
  const posted = await request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers: await xsrf(page),
    data: {
      operations: [
        {
          operationId: crypto.randomUUID(),
          baseRevision: 0,
          body: {
            type: 'item.source',
            itemId: id('n1'),
            source: '---\nage: 45\nexpected_premium: 1200\n---\n# Policy quote',
          },
        },
      ],
    },
  });
  expect(posted.ok(), await posted.text()).toBe(true);
  await expect
    .poll(overview, { timeout: 20_000 })
    .toMatch(/a2 +app "Expected vs actual" · fresh · v2/);
  expect(await overview()).toMatch(/a1 +app "Premium" · fresh · v2: expected=1200, premium=1350/);
  expect(await call(request, 'item_read', { ...b, ref: 'c1' })).toMatch(/c1\/t1 \[blocked\]/);
  // Credited to the app, after the edit that caused it.
  expect(await call(request, 'item_read', { ...b, ref: 'a1' })).toMatch(
    /Output v2 · ok — run by a1, after .+'s edit to n1/,
  );
  expect(await call(request, 'item_read', { ...b, ref: 'a2' })).toMatch(
    /Output v2 · ok — run by a2, after .+'s edit to a1/,
  );
});
