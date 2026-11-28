import { expect, test } from '@playwright/test';
import { call, fixture, SERVER, xsrf } from './apps-server';

/**
 * The reduced insurance scenario (openspec canvas-apps-poc 7.2, agents/apps),
 * against a real server with its app sandbox and the built bundle: nothing is
 * stubbed. An agent builds the board over /mcp: a note feeds a premium
 * calculator a1, a1 feeds a comparison a2, a2 updates checklist c1. A person
 * has the board open, so the apps on screen are live; the agent runs them, the person edits the note, the
 * agent sees both stale, runs them again and c1's task follows the verdict.
 *
 * Run with `just e2e-apps`, which starts the server and sets VISARIUM_E2E_SERVER.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

test('an agent sees apps go stale after a person edits their input, and repairs them', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);

  const made = await request.post(`${SERVER}/api/boards`, {
    headers: await xsrf(page),
    data: { title: 'Policy check' },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const board = ((await made.json()) as { id: string }).id;
  const b = { board };

  // The agent builds it.
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
  let overview = await call(request, 'board_read', b);
  expect(overview).toMatch(/a1 +app "Premium" · never run/);
  expect(overview).toMatch(/a2 +app "Expected vs actual" · never run/);

  // Nobody has a1 open yet: an agent cannot run it.
  expect(await call(request, 'app_run', { ...b, ref: 'a1' })).toMatch(/^needs_viewer/);

  const snap = (await (await request.get(`${SERVER}/api/boards/${board}/snapshot`)).json()) as {
    items: { id: string; ref: string }[];
  };
  const id = (ref: string) => snap.items.find((i) => i.ref === ref)?.id ?? '';

  // A person opens the board on the desktop (here: the bundle the desktop embeds).
  await page.goto(`${SERVER}/boards/${board}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  // The whole board in view: only what is on screen is drawn, and an app is live only there.
  await page.getByRole('button', { name: 'Fit' }).click();
  for (const ref of ['n1', 'c1', 'a1', 'a2'])
    await page
      .waitForFunction(
        (i) =>
          (
            window as unknown as { Konva: { stages: { findOne(s: string): unknown }[] } }
          ).Konva.stages[0]?.findOne(`#${i}`) !== undefined,
        id(ref),
        { timeout: 15_000 },
      )
      .catch((e) => {
        throw new Error(`${ref} (${id(ref)}) not drawn: ${e}`);
      });

  /** An app on the person's screen is live; the agent runs it once the room knows. */
  const openAndRun = async (ref: string) => {
    const live = page.locator(`[data-testid="app-view"][data-item-id="${id(ref)}"]`);
    await expect(live).toBeVisible();
    // The room hears the view open a moment after it shows.
    for (let tries = 0; tries < 50; tries++) {
      const text = await call(request, 'app_run', { ...b, ref });
      if (!text.startsWith('needs_viewer')) return text;
      await page.waitForTimeout(200);
    }
    const stats = await page.getByTestId('canvas-stats').textContent();
    throw new Error(`${ref} never reached the room as open (${stats})`);
  };
  const view = page.frameLocator(`[data-testid="app-view"][data-item-id="${id('a2')}"] iframe`);

  let ran = await openAndRun('a1');
  expect(ran).toContain('Ran a1.');
  expect(ran).toContain('premium=1200');
  ran = await openAndRun('a2');
  expect(ran).toContain('verdict="match"');
  await expect(view.locator('#verdict')).toHaveText('match');
  let list = await call(request, 'item_read', { ...b, ref: 'c1' });
  expect(list).toMatch(/c1\/t1 \[done\] Premium matches the quote — a2 run by /);

  // The person edits the note's inputs.
  const note = await call(request, 'item_read', { ...b, ref: 'n1' });
  expect(note).toContain('age: 40');
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

  // The agent sees both behind, and why.
  overview = await call(request, 'board_read', b);
  expect(overview).toMatch(
    /a1 +app "Premium" · stale \(n1 rev \d+→\d+\) · v1: expected=1200, premium=1200/,
  );
  expect(overview).toMatch(/a2 +app "Expected vs actual" · upstream stale \(a1\) · v1/);

  // It runs them again, in order, with the person's view open on each.
  ran = await openAndRun('a1');
  expect(ran).toContain('premium=1350');
  ran = await openAndRun('a2');
  expect(ran).toContain('verdict="mismatch"');
  await expect(view.locator('#verdict')).toHaveText('mismatch');
  // The view's picture of v2 becomes a2's card, for everyone (canvas/apps).
  const cardOf = async (ref: string) => {
    const s = (await (await request.get(`${SERVER}/api/boards/${board}/snapshot`)).json()) as {
      items: { ref: string; output?: { version: number; card?: string | null } }[];
    };
    const o = s.items.find((i) => i.ref === ref)?.output;
    return o ? `v${o.version}:${o.card ?? ''}` : '';
  };
  await expect.poll(() => cardOf('a2'), { timeout: 10_000 }).toMatch(/^v2:[\s\S]*mismatch/);

  overview = await call(request, 'board_read', b);
  expect(overview).toMatch(/a1 +app "Premium" · fresh · v2/);
  expect(overview).toMatch(/a2 +app "Expected vs actual" · fresh · v2/);
  list = await call(request, 'item_read', { ...b, ref: 'c1' });
  expect(list).toMatch(/c1\/t1 \[blocked\] Premium matches the quote — a2 run by /);
  const app = await call(request, 'item_read', { ...b, ref: 'a2' });
  expect(app).toMatch(/Output v2 · ok — run by /);
});
