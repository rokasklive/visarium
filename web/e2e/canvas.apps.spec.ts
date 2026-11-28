import { readFileSync } from 'node:fs';
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
    extra = [],
    output,
  }: {
    links?: unknown[];
    mount?: boolean;
    html?: string;
    extra?: unknown[];
    output?: unknown;
  } = {},
) {
  const posted: Op[] = [];
  let age = 34;
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          at(NOTE, -300, 0, 200, 100, { kind: 'note', source: '---\nage: 34\n---\n# Policy' }),
          {
            ...at(APP, 100, 0, 300, 200, { kind: 'app', title: 'Premium', html }),
            ...(output ? { output } : {}),
          },
          at(LIST, 100, 260, 200, 100, {
            kind: 'checklist',
            title: 'Regression',
            tasks: [{ id: 't1', text: 'Young driver', state: 'todo' }],
          }),
          ...extra,
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
  // The server says where app views load from, or that it has nowhere.
  await page.route('**/api/meta', (route) =>
    route.fulfill({
      json: {
        name: 'visarium',
        version: '0.0.0',
        protocolVersion: 4,
        appsOrigin: mount ? SANDBOX : null,
      },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/items/*/mount`, (route) =>
    mount
      ? route.fulfill({ json: { url: `${SANDBOX}/app/token`, origin: SANDBOX } })
      : route.fulfill({ status: 404, json: { detail: 'apps need a sandbox origin to run' } }),
  );
  // What the server resolves for the app: the note's frontmatter, by its default
  // name, while a feeds link from the note carries it (canvas/apps).
  await page.route(`**/api/boards/${BOARD}/items/${APP}/inputs`, (route) => {
    const fed = [...(links as Op[]), ...posted.filter((o) => o.type === 'link.add')].some(
      (l) => l.linkType === 'feeds' && (l.from as { itemId: string }).itemId === NOTE,
    );
    route.fulfill({
      json: {
        values: fed ? { 'n1.frontmatter': { age } } : {},
        inputs: fed
          ? [
              {
                name: 'n1.frontmatter',
                origin: 'link',
                linkId: FEED,
                itemId: NOTE,
                ref: 'n1',
                view: 'frontmatter',
                path: null,
                value: { age },
                fields: ['age'],
              },
            ]
          : [],
        declared: [],
        stamps: {},
        feeds: [],
        updates: [],
        ranBy: null,
      },
    });
  });
  // The kit's script, as the sandbox serves it: it sends the board snapshots.
  await page.route(`${SANDBOX}/kit.js`, (route) =>
    route.fulfill({
      body: readFileSync(new URL('../../server/src/app_kit.js', import.meta.url), 'utf8'),
      headers: { 'content-type': 'text/javascript' },
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

/** An app on screen at a readable size is live: its view is up over its card. */
async function openView(page: Page, _c?: { x: number; y: number }) {
  await expect(page.getByTestId('app-view')).toBeVisible();
}

/** Selecting a live app gives its band Run and its run mode. */
async function selectApp(page: Page) {
  const at = await centreOf(page, APP);
  await page.mouse.click(at.x, at.y + 40);
  await expect(page.getByTestId('app-run')).toBeVisible();
}
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

test('an app on screen is live over its card, follows it as the board zooms, and is a card again zoomed out', async ({
  page,
}) => {
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
  await openView(page, c);
  await logged(page, 'ui/notifications/tool-input');
  await expectAligned(page);

  // Zoom in and back, away from the view: it follows its card.
  for (const dy of [-240, 240]) {
    await page.mouse.move(c.x - 300, c.y + 200);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
    await expect(page.getByTestId('app-view')).toBeVisible();
    await expectAligned(page);
  }

  // Too small to read: its card, and no view running.
  await page.mouse.move(c.x - 300, c.y + 200);
  await page.mouse.wheel(0, 1200);
  await expect(page.getByTestId('app-view')).toHaveCount(0);
});

/** An app that draws a block and a figure, and tries everything a card must not keep. */
const HOSTILE = `<!doctype html><html><head><script src="/kit.js"></script>
<style>.chart{background:#c00;height:80px}.leak{background:url(https://x.example/bg.png)}</style></head>
<body><div class="chart" onclick="steal()"></div><p class="figure">1200</p>
<img src="https://x.example/pixel.gif"><div class="leak">x</div>
<svg width="10" height="10"><foreignObject><p>nested</p></foreignObject></svg>
<script>window.steal = () => {};</script></body></html>`;

test("an app's card is a cleaned snapshot of its view, drawn as an image that reaches nothing", async ({
  page,
}) => {
  // What the board itself asks for: the live view is the app's own (its CSP blocks it).
  const outside: string[] = [];
  page.on('request', (r) => {
    if (r.frame() === page.mainFrame() && r.url().includes('x.example')) outside.push(r.url());
  });
  const { posted } = await stubBoard(page, {
    html: HOSTILE,
    output: { version: 1, outputs: { premium: 1200 }, inputRevs: {}, status: 'ok' },
  });
  const c = await open(page);
  await openView(page, c);
  // The view settles; its picture becomes the card of output v1.
  await expect.poll(() => posted.find((op) => op.type === 'app.card')).toBeTruthy();
  const card = posted.find((op) => op.type === 'app.card') as Op & { html: string };
  expect(card).toMatchObject({ itemId: APP, version: 1 });
  expect(card.html).toContain('1200');
  expect(card.html).toContain('#c00');
  expect(card.html).toMatch(/data-card-width="\d+"/);
  for (const gone of ['x.example', 'onclick', 'steal', '<script', 'foreignObject'])
    expect(card.html, gone).not.toContain(gone);
  // Only one card per version.
  await page.waitForTimeout(800);
  expect(posted.filter((op) => op.type === 'app.card')).toHaveLength(1);

  // Zoomed out, the card shows that picture, drawn inside the card's own image.
  await page.mouse.move(c.x - 300, c.y + 200);
  await page.mouse.wheel(0, 1200);
  await expect(page.getByTestId('app-view')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window as unknown as { __objects: { layout(i: string): { svg: string } | undefined } }
          ).__objects.layout(id)?.svg ?? '',
        APP,
      ),
    )
    .toContain('#c00');
  expect(outside).toEqual([]);
});

test('of six apps on screen, the four largest are live', async ({ page }) => {
  const others = [5, 6, 7, 8, 9].map((n, i) =>
    at(`${APP.slice(0, -1)}${n}`, -700 + i * 330, -330, 240 + i * 10, 160, {
      kind: 'app',
      title: `App ${n}`,
      html: ECHO,
    }),
  );
  await stubBoard(page, { extra: others });
  await open(page);
  await expect(page.getByTestId('app-view')).toHaveCount(4);
  const live = await page
    .getByTestId('app-view')
    .evaluateAll((views) => views.map((v) => v.getAttribute('data-item-id')));
  // The original app (300 wide) and the three widest of the others.
  expect(live.sort()).toEqual(
    [APP, `${APP.slice(0, -1)}7`, `${APP.slice(0, -1)}8`, `${APP.slice(0, -1)}9`].sort(),
  );
});

test('a live app takes the pointer only once it is selected', async ({ page }) => {
  const { posted } = await stubBoard(page);
  const c = await open(page);
  await openView(page, c);
  const iframe = page.locator('[data-testid="app-view"] iframe');
  const pointer = () => iframe.evaluate((f) => getComputedStyle(f).pointerEvents);
  expect(await pointer()).toBe('none');
  await expect(page.getByTestId('app-run')).toHaveCount(0);

  // The wheel over it moves the board, not the app.
  const before = await rectOf(page, APP);
  const centre = await centreOf(page, APP);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await rectOf(page, APP)).width).not.toBe(before.width);
  await expectAligned(page);

  // One click selects it; then the view takes the pointer, and the band its controls.
  const now = await centreOf(page, APP);
  await page.mouse.click(now.x, now.y + 40);
  await expect(page.getByTestId('canvas-stats')).toContainText('1 selected');
  await expect.poll(pointer).toBe('auto');
  await expect(page.getByTestId('app-run')).toBeVisible();
  await page.getByTestId('app-mode').click();
  await expect
    .poll(() => posted.find((op) => op.type === 'app.set'))
    .toMatchObject({ itemId: APP, run: 'manual' });
  await expect(page.getByTestId('app-mode')).toHaveText('manual');
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
  await openView(page, c);

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

test("a feeds link's label opens what it carries: view, field and name", async ({ page }) => {
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
  const popover = page.getByTestId('link-popover');
  await expect(popover).toBeVisible();
  expect(posted.filter((op) => op.type === 'link.set')).toEqual([]);
  // The field picker offers what the view holds now.
  await expect(popover.locator('datalist option')).toHaveAttribute('value', 'age');
  await popover.getByLabel('Field').fill('age');
  await popover.getByLabel('Field').press('Enter');
  await expect
    .poll(() => posted.find((op) => op.type === 'link.set'))
    .toMatchObject({ linkId: FEED, linkType: 'feeds', path: 'age' });
  await popover.getByLabel('View').selectOption('tables');
  await expect
    .poll(() => posted.filter((op) => op.type === 'link.set').at(-1))
    .toMatchObject({ linkId: FEED, view: 'tables' });
  // A name another input has is refused before anything is sent.
  const sent = posted.length;
  await popover.getByLabel('Input name').fill('a b');
  await popover.getByLabel('Input name').press('Enter');
  await expect(popover.getByRole('alert')).toContainText('An input name is');
  expect(posted.length).toBe(sent);
  // Escape puts the field back first, then closes.
  await page.keyboard.press('Escape');
  await expect(popover.getByLabel('Input name')).toHaveValue('n1.frontmatter');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

test('without a sandbox origin, apps stay cards and the inspector says why', async ({ page }) => {
  await stubBoard(page, { mount: false });
  const c = await open(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('app-view')).toHaveCount(0);
  await page.mouse.dblclick(c.x + 100, c.y);
  await expect(page.getByTestId('no-sandbox')).toContainText('Apps need a sandbox origin to run');
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

test('on a board shared read-only, the inspector shows the source and changes nothing', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.route('**/api/shared/session', (route) =>
    route.fulfill({ json: { member: false, boardId: BOARD, title: 'Apps', sharedBy: 'Ada' } }),
  );
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        groups: [],
        links: [],
        items: [at(APP, 0, 0, 300, 200, { kind: 'app', title: 'Premium', html: ECHO })],
        id: BOARD,
        title: 'Apps',
        sharedBy: 'Ada',
        expiresAt: null,
      },
    }),
  );
  await page.goto('/s#share-token');
  await expect(page.getByText('Shared by Ada · view only')).toBeVisible();
  await expect.poll(() => rectOf(page, APP).catch(() => null)).not.toBeNull();
  const c = await centreOf(page, APP);
  await page.mouse.dblclick(c.x, c.y);
  const inspector = page.getByTestId('app-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByTestId('inspector-source')).toHaveValue(ECHO);
  await expect(inspector.getByTestId('inspector-source')).toHaveAttribute('readonly', '');
  await expect(inspector.getByRole('button', { name: '+ Literal' })).toHaveCount(0);
  await expect(inspector.getByTestId('output-status')).toHaveText('never run');
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
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
    await openView(page, c);
    await expect(page.getByTestId('app-view')).toBeVisible();
    pages.push(page);
  }
  const [ada, bo] = pages as [Page, Page];
  // Publishing before any run is refused by the host.
  await expect.poll(async () => (await appLog(ada)).find(([k]) => k === 'early')?.[1]).toBe(-32001);

  await selectApp(bo);
  await selectApp(ada);
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
  await openView(page, c);
  await expect(page.getByTestId('app-view')).toBeVisible();
  await expect
    .poll(async () => (await appLog(page)).find(([k]) => k === 'early')?.[1])
    .toBe(-32001);
  await selectApp(page);
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
