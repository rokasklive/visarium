import { expect, type Page, test } from '@playwright/test';
import { canvasBox, signedIn } from './session';

/**
 * Canvas apps (canvas/apps, canvas/links): a card at rest; double-click mounts
 * the view from another origin over it, aligned at any zoom, spoken to over the
 * MCP Apps bridge, with what feeds it as its input and nothing else reachable.
 * World origin is the canvas centre at zoom 1; a transform's x and y are the
 * item's centre.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f8000';
const NOTE = '01a01640-6b72-7d60-968b-88be186f8001';
const APP = '01a01640-6b72-7d60-968b-88be186f8002';
const LIST = '01a01640-6b72-7d60-968b-88be186f8003';
const FEED = '01a01640-6b72-7d60-968b-88be186f8004';
const SANDBOX = 'http://127.0.0.1:5199';
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*";

/** An app that logs everything the host says, and tries what it must not do. */
const ECHO = `<!doctype html><html><body><pre id="log">[]</pre><script>
const all = [];
const log = (k, v) => { all.push([k, v]); document.getElementById('log').textContent = JSON.stringify(all); };
let n = 0; const pending = {};
const req = (method, params) => new Promise((r) => { const id = ++n; pending[id] = r; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); });
addEventListener('message', (e) => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && !m.method) { pending[m.id] && pending[m.id](m); return; }
  if (m.method === 'ui/resource-teardown') { parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*'); return; }
  log(m.method, m.params);
});
(async () => {
  const init = await req('ui/initialize', { appInfo: { name: 'echo', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
  log('initialize', init.result.hostCapabilities.experimental);
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
  const unknown = await req('foo/bar', {});
  log('unknown', unknown.error.code);
  try { await fetch('https://example.com/'); log('fetch', 'allowed'); } catch { log('fetch', 'blocked'); }
  try { log('parent', String(parent.document.title)); } catch { log('parent', 'blocked'); }
})();
</script></body></html>`;

const at = (id: string, x: number, y: number, width: number, height: number, content: unknown) => ({
  id,
  transform: { x, y, width, height, rotation: 0 },
  z: 1,
  revision: 0,
  contentRev: 1,
  content,
});

interface Op {
  type: string;
  [k: string]: unknown;
}

async function stubBoard(
  page: Page,
  {
    links = [],
    mount = true,
    html = ECHO,
  }: { links?: unknown[]; mount?: boolean; html?: string } = {},
) {
  const posted: Op[] = [];
  let age = 34;
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          at(NOTE, -300, 0, 200, 100, { kind: 'note', source: '---\nage: 34\n---\n# Policy' }),
          at(APP, 100, 0, 300, 200, { kind: 'app', title: 'Premium', html }),
          at(LIST, 100, 260, 200, 100, {
            kind: 'checklist',
            title: 'Regression',
            tasks: [{ id: 't1', text: 'Young driver', state: 'todo' }],
          }),
        ],
        groups: [],
        links,
        people: {},
      },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  await page.route(`**/api/boards/${BOARD}/items/${APP}/mount`, (route) =>
    mount
      ? route.fulfill({ json: { url: `${SANDBOX}/app/token`, origin: SANDBOX } })
      : route.fulfill({ status: 404, json: { detail: 'apps run in the desktop app' } }),
  );
  await page.route(`**/api/boards/${BOARD}/items/${NOTE}/views/frontmatter`, (route) =>
    route.fulfill({
      json: { ref: 'n1', kind: 'note', revision: 1, view: 'frontmatter', value: { age } },
    }),
  );
  await page.route(`${SANDBOX}/app/token`, (route) =>
    route.fulfill({
      body: html,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
    }),
  );
  return { posted, setAge: (a: number) => (age = a) };
}

async function open(page: Page, labs = true) {
  if (labs) await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await canvasBox(page);
  for (const id of [NOTE, APP, LIST])
    await page.waitForFunction(
      (i) =>
        (
          window as unknown as {
            Konva: { stages: { findOne(s: string): { className: string } | undefined }[] };
          }
        ).Konva.stages[0]?.findOne(`#${i}`)?.className === 'Image',
      id,
    );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where the board draws an item now, in page pixels. */
async function rectOf(page: Page, id: string) {
  const box = await canvasBox(page);
  const r = await page.evaluate(
    (i) =>
      (
        window as unknown as {
          Konva: {
            stages: {
              findOne(
                s: string,
              ):
                | { getClientRect(): { x: number; y: number; width: number; height: number } }
                | undefined;
            }[];
          };
        }
      ).Konva.stages[0]
        ?.findOne(`#${i}`)
        ?.getClientRect(),
    id,
  );
  if (!r) throw new Error(`no ${id}`);
  return { x: box.x + r.x, y: box.y + r.y, width: r.width, height: r.height };
}

const centreOf = async (page: Page, id: string) => {
  const r = await rectOf(page, id);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

const frame = (page: Page) => page.frameLocator('[data-testid="app-view"] iframe');
const appLog = async (page: Page): Promise<[string, unknown][]> =>
  JSON.parse((await frame(page).locator('#log').textContent()) ?? '[]');
const logged = (page: Page, key: string) =>
  expect
    .poll(async () => (await appLog(page)).filter(([k]) => k === key).map(([, v]) => v))
    .not.toEqual([]);

async function expectAligned(page: Page) {
  const card = await rectOf(page, APP);
  const view = await page.getByTestId('app-view').boundingBox();
  if (!view) throw new Error('no view');
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(view[k] - card[k]), `${k}: view ${view[k]}, card ${card[k]}`).toBeLessThan(2);
}

test('double-click mounts the view over its card, aligned at every zoom', async ({ page }) => {
  await stubBoard(page, {
    links: [
      {
        id: FEED,
        from: { itemId: NOTE },
        to: { itemId: APP },
        linkType: 'feeds',
        view: 'frontmatter',
      },
    ],
  });
  const c = await open(page);
  await page.mouse.dblclick(c.x + 100, c.y);
  await expect(page.getByTestId('app-view')).toBeVisible();
  await logged(page, 'ui/notifications/tool-input');
  await expectAligned(page);

  // Zoom in and out away from the view: it follows its card.
  for (const dy of [-240, 480]) {
    await page.mouse.move(c.x - 300, c.y + 200);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
    await expect(page.getByTestId('app-view')).toBeVisible();
    await expectAligned(page);
  }

  await page.getByTestId('app-close').click();
  await expect(page.getByTestId('app-view')).toHaveCount(0);
});

test('the view speaks the MCP Apps bridge, reads only what feeds it, and reaches nothing', async ({
  page,
}) => {
  const board = await stubBoard(page, {
    links: [
      {
        id: FEED,
        from: { itemId: NOTE },
        to: { itemId: APP },
        linkType: 'feeds',
        view: 'frontmatter',
      },
    ],
  });
  const c = await open(page);
  await page.mouse.dblclick(c.x + 100, c.y);

  await logged(page, 'initialize');
  await logged(page, 'unknown');
  await logged(page, 'fetch');
  await logged(page, 'parent');
  const log = await appLog(page);
  const one = (k: string) => log.find(([key]) => key === k)?.[1];
  expect(one('initialize')).toEqual({ 'dev.visarium/canvas': { version: 1 } });
  expect(one('ui/notifications/tool-input')).toEqual({
    arguments: { 'n1.frontmatter': { age: 34 } },
  });
  expect(one('unknown')).toBe(-32601);
  expect(one('fetch'), 'connect-src none').toBe('blocked');
  expect(one('parent'), 'another origin').toBe('blocked');

  // Another client edits the note: the view hears its new input.
  board.setAge(19);
  await page.evaluate(
    (id) =>
      (window as unknown as { __objects: { remote(b: unknown): void } }).__objects.remote({
        type: 'item.source',
        itemId: id,
        source: '---\nage: 19\n---\n# Policy',
      }),
    NOTE,
  );
  await logged(page, 'visarium/notifications/inputs-changed');
  const changed = (await appLog(page)).find(([k]) => k === 'visarium/notifications/inputs-changed');
  expect(changed?.[1]).toEqual({ arguments: { 'n1.frontmatter': { age: 19 } } });
});

test('dragging onto an app feeds it; from an app onto a checklist lets it update it', async ({
  page,
}) => {
  const { posted } = await stubBoard(page);
  await open(page);
  const alt = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
  };
  const adds = () => posted.filter((op) => op.type === 'link.add');

  await alt(await centreOf(page, NOTE), await centreOf(page, APP));
  await expect.poll(() => adds().length).toBe(1);
  expect(adds()[0]).toMatchObject({
    from: { itemId: NOTE },
    to: { itemId: APP },
    linkType: 'feeds',
    view: 'text',
  });

  await alt(await centreOf(page, APP), await centreOf(page, LIST));
  await expect.poll(() => adds().length).toBe(2);
  expect(adds()[1]).toMatchObject({
    from: { itemId: APP },
    to: { itemId: LIST },
    linkType: 'updates',
  });
});

test("a feeds link's label cycles the views of its source", async ({ page }) => {
  const { posted } = await stubBoard(page, {
    links: [
      {
        id: FEED,
        from: { itemId: NOTE },
        to: { itemId: APP },
        linkType: 'feeds',
        view: 'frontmatter',
      },
    ],
  });
  const c = await open(page);
  type Drawn = { id: string; from: { x: number; y: number }; to: { x: number; y: number } };
  const lines = () =>
    page.evaluate(() =>
      (window as unknown as { __objects: { links(): Drawn[] } }).__objects.links(),
    );
  await expect.poll(async () => (await lines()).length).toBe(1);
  const [l] = await lines();
  if (!l) throw new Error('no link');
  const m = { x: c.x + (l.from.x + l.to.x) / 2, y: c.y + (l.from.y + l.to.y) / 2 };
  await page.mouse.click(m.x, m.y);
  await page.waitForTimeout(500);
  await page.mouse.click(m.x, m.y - 8);
  await expect.poll(() => posted.filter((op) => op.type === 'link.set').length).toBe(1);
  expect(posted.find((op) => op.type === 'link.set')).toMatchObject({
    linkId: FEED,
    linkType: 'feeds',
    view: 'tables',
  });
});

test('without a sandbox, or with the experiment off, the app says why it will not open', async ({
  page,
}) => {
  await stubBoard(page, { mount: false });
  const c = await open(page);
  await page.mouse.dblclick(c.x + 100, c.y);
  await expect(page.getByTestId('interchange-notice')).toContainText('runs in the desktop app');
  await expect(page.getByTestId('app-view')).toHaveCount(0);
});

test('canvas apps stay shut until Labs turns them on', async ({ page }) => {
  await stubBoard(page);
  const c = await open(page, false);
  await page.mouse.dblclick(c.x + 100, c.y);
  await expect(page.getByTestId('interchange-notice')).toContainText('Settings → Labs');
  await expect(page.getByTestId('app-view')).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

// --- runs (canvas/apps: one executor per run) --------------------------------

/** An app that publishes only when told to run, and ticks the regression task. */
const RUNNER = `<!doctype html><html><body><pre id="log">[]</pre><script>
const all = [];
const log = (k, v) => { all.push([k, v]); document.getElementById('log').textContent = JSON.stringify(all); };
let n = 0; const pending = {};
const req = (method, params) => new Promise((r) => { const id = ++n; pending[id] = r; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); });
addEventListener('message', async (e) => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && !m.method) { pending[m.id] && pending[m.id](m); return; }
  if (m.method === 'ui/resource-teardown') { parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*'); return; }
  if (m.method !== 'visarium/notifications/run') return;
  const age = (m.params.arguments['n1.frontmatter'] || {}).age;
  const out = await req('visarium/outputs/publish', { outputs: { premium: age * 10 } });
  log('published', out.error ? out.error.code : 'ok');
  const tick = await req('visarium/items/propose', { changes: [{ type: 'task.set', itemId: '${LIST}', taskId: 't1', state: 'done' }] });
  log('proposed', tick.error ? tick.error.code : 'ok');
});
(async () => {
  await req('ui/initialize', { appInfo: { name: 'runner', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
  const early = await req('visarium/outputs/publish', { outputs: { premium: 0 } });
  log('early', early.error ? early.error.code : 'ok');
})();
</script></body></html>`;

/**
 * A room for several pages, as the server keeps one: who has the app open, and
 * one run at a time. The lease rules themselves are the server's, tested there
 * (server/tests/api.rs); this is the client's side of them.
 */
function fakeRoom() {
  const sockets = new Map<string, { send(m: string): void }>();
  let lease: { itemId: string; holder: string } | undefined;
  const broadcast = (f: unknown) => {
    for (const ws of sockets.values()) ws.send(JSON.stringify(f));
  };
  const actors = [
    { actorId: 'ada', displayName: 'Ada', colourIndex: 0 },
    { actorId: 'bo', displayName: 'Bo', colourIndex: 1 },
  ];
  return {
    attach: (page: Page, actor: 'ada' | 'bo') =>
      page.routeWebSocket('**/ws/canvas/**', (ws) => {
        sockets.set(actor, ws);
        ws.onMessage((raw) => {
          const f = JSON.parse(String(raw)) as { t: string; itemIds?: string[] };
          if (f.t === 'hello')
            ws.send(JSON.stringify({ t: 'welcome', actorId: actor, revision: 1, actors }));
          if (f.t === 'run.request') {
            const itemId = f.itemIds?.[0] as string;
            if (lease) ws.send(JSON.stringify({ t: 'run.busy', itemId, holder: lease.holder }));
            else {
              lease = { itemId, holder: actor };
              broadcast({ t: 'run.lease', itemId, holder: actor, until: Date.now() + 30_000 });
            }
          }
        });
      }),
    end: () => {
      if (lease) broadcast({ t: 'run.end', itemId: lease.itemId });
      lease = undefined;
    },
  };
}

/** Operations as the server answers them during runs: an output ends the run. */
async function stubRuns(
  page: Page,
  room: ReturnType<typeof fakeRoom>,
  posted: Op[],
  refuse?: () => string | undefined,
  endOnOutput = true,
) {
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    const ops = body.operations.map((o) => o.body);
    const refused = ops.some((op) => op.type === 'app.output') ? refuse?.() : undefined;
    if (endOnOutput && ops.some((op) => op.type === 'app.output')) room.end();
    if (refused) {
      await route.fulfill({ status: 409, json: { detail: refused } });
      return;
    }
    posted.push(...ops);
    await route.fulfill({ json: { revision: 1 + posted.length, operations: ops } });
  });
}

const feedsAndUpdates = [
  { id: FEED, from: { itemId: NOTE }, to: { itemId: APP }, linkType: 'feeds', view: 'frontmatter' },
  { id: `${FEED.slice(0, -1)}5`, from: { itemId: APP }, to: { itemId: LIST }, linkType: 'updates' },
];

test('two viewers have an app open: one runs it, once, and the other sees who', async ({
  browser,
}) => {
  const room = fakeRoom();
  const posted: Op[] = [];
  const pages: Page[] = [];
  for (const actor of ['ada', 'bo'] as const) {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    await signedIn(page);
    await stubBoard(page, { links: feedsAndUpdates, html: RUNNER });
    // The run stays Ada's until the test ends it, so Bo's view can be read meanwhile.
    await stubRuns(page, room, posted, undefined, false);
    await room.attach(page, actor);
    const c = await open(page);
    await page.mouse.dblclick(c.x + 100, c.y);
    await expect(page.getByTestId('app-view')).toBeVisible();
    pages.push(page);
  }
  const [ada, bo] = pages as [Page, Page];
  // Publishing before any run is refused by the host.
  await expect.poll(async () => (await appLog(ada)).find(([k]) => k === 'early')?.[1]).toBe(-32001);

  await ada.getByTestId('app-run').click();
  await expect
    .poll(async () => (await appLog(ada)).find(([k]) => k === 'published')?.[1])
    .toBe('ok');
  await expect
    .poll(async () => (await appLog(ada)).find(([k]) => k === 'proposed')?.[1])
    .toBe('ok');
  // Bo sees who is running it, and cannot start a second run meanwhile.
  await expect(bo.getByTestId('app-running')).toHaveText('running for Ada');
  await expect(bo.getByTestId('app-run')).toBeDisabled();
  await expect(ada.getByTestId('app-running')).toHaveText('running');
  room.end();
  await expect(bo.getByTestId('app-run')).toBeEnabled();
  await expect(bo.getByTestId('app-running')).not.toHaveText(/running/);

  // Exactly one output, and the tick credited to the app.
  await expect.poll(() => posted.filter((op) => op.type === 'app.output').length).toBe(1);
  expect(posted.find((op) => op.type === 'app.output')).toMatchObject({
    itemId: APP,
    outputs: { premium: 340 },
  });
  expect(posted.find((op) => op.type === 'task.set')).toMatchObject({
    itemId: LIST,
    taskId: 't1',
    state: 'done',
    byApp: APP,
  });
  expect((await appLog(bo)).find(([k]) => k === 'published')).toBeUndefined();
  for (const p of pages) await p.context().close();
});

test('an input changed mid-run: the output does not count, and the app says so', async ({
  page,
}) => {
  const room = fakeRoom();
  const posted: Op[] = [];
  await stubBoard(page, { links: feedsAndUpdates, html: RUNNER });
  await stubRuns(
    page,
    room,
    posted,
    () => 'superseded: what feeds this app changed during the run; run it again',
  );
  await room.attach(page, 'ada');
  const c = await open(page);
  await page.mouse.dblclick(c.x + 100, c.y);
  await expect(page.getByTestId('app-view')).toBeVisible();
  await expect
    .poll(async () => (await appLog(page)).find(([k]) => k === 'early')?.[1])
    .toBe(-32001);
  await page.getByTestId('app-run').click();
  await expect(page.getByTestId('interchange-notice')).toContainText('superseded');
  expect(posted.filter((op) => op.type === 'app.output')).toEqual([]);
  // The board is the server's again: no output on the app.
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const item = (
          window as unknown as { __objects: { item(i: string): { content: { output?: unknown } } } }
        ).__objects.item(id);
        return item.content.output ?? null;
      }, APP),
    )
    .toBeNull();
});
