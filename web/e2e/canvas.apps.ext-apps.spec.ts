import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { newBoard, rectOf, SERVER, showBoard, xsrf } from './apps-server';

/**
 * Three official MCP Apps examples (modelcontextprotocol/ext-apps 2.0.4) on a
 * board (canvas/app-sources, openspec canvas-apps-live 10.4): their own built
 * views, unchanged, served by an MCP server that answers their tools
 * (fixtures/mcp/ext-apps-server.mjs). Each runs its tool on the server,
 * renders the result live, and works when a person uses it.
 *
 * Run with `just e2e-apps`, which fetches the views (fetch-ext-apps.sh),
 * starts the server with VISARIUM_MCP_ALLOW=127.0.0.1 and sets
 * VISARIUM_E2E_SERVER.
 */

const VIEWS = new URL('../node_modules/.cache/ext-apps/', import.meta.url);
test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');
test.skip(
  !existsSync(new URL('cohort-heatmap.html', VIEWS)),
  'needs the ext-apps views: run web/e2e/fixtures/mcp/fetch-ext-apps.sh',
);

const PORT = 18792;
let mcp: ChildProcess;

test.beforeAll(async () => {
  mcp = spawn(
    'node',
    [new URL('./fixtures/mcp/ext-apps-server.mjs', import.meta.url).pathname, `${PORT}`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((ready) => mcp.stdout?.once('data', () => ready()));
});

test.afterAll(() => {
  mcp.kill();
});

/** A board with one tool-backed app per example, side by side; their ids. */
async function examples(page: Page): Promise<{ board: string; ids: Record<string, string> }> {
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'ext-apps');
  const headers = await xsrf(page);
  const conn = await page.request.post(`${SERVER}/api/boards/${board}/mcp`, {
    headers,
    data: { url: `http://127.0.0.1:${PORT}/mcp` },
  });
  expect(conn.ok(), await conn.text()).toBe(true);
  const { id: connection, tools } = (await conn.json()) as {
    id: string;
    tools: { name: string; resourceUri: string }[];
  };
  expect(tools.map((t) => t.name)).toEqual(['get-time', 'get-budget-data', 'get-cohort-data']);
  const ops = [];
  const ids: Record<string, string> = {};
  for (const [i, t] of tools.entries()) {
    const pinned = await page.request.post(
      `${SERVER}/api/boards/${board}/mcp/${connection}/resource`,
      {
        headers,
        data: { uri: t.resourceUri },
      },
    );
    expect(pinned.ok(), await pinned.text()).toBe(true);
    const { sha256 } = (await pinned.json()) as { sha256: string };
    const itemId = crypto.randomUUID();
    ids[t.name] = itemId;
    ops.push({
      operationId: crypto.randomUUID(),
      baseRevision: 0,
      body: {
        type: 'item.create',
        itemId,
        transform: { x: i * 560, y: 0, width: 520, height: 560, rotation: 0 },
        content: {
          kind: 'app',
          title: t.name,
          html: '',
          mcp: { connection, resourceUri: t.resourceUri, tool: t.name, sha256 },
        },
      },
    });
  }
  const posted = await page.request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers,
    data: { operations: ops },
  });
  expect(posted.ok(), await posted.text()).toBe(true);
  return { board, ids };
}

const frame = (page: Page, id: string) =>
  page.frameLocator(`[data-testid="app-view"][data-item-id="${id}"] iframe`);

/** Selects an app on its band, so its view takes the pointer. */
async function select(page: Page, id: string) {
  const r = await rectOf(page, id);
  await page.mouse.click(r.x + r.width / 2, r.y + 12);
  await page.waitForTimeout(600);
}

test('three ext-apps examples render their tool results and work when used', async ({ page }) => {
  test.setTimeout(120_000);
  const { board, ids } = await examples(page);
  const [time, money, cohort] = [
    ids['get-time'],
    ids['get-budget-data'],
    ids['get-cohort-data'],
  ] as string[];
  // Opened at once: each view starts before its tool has run on the server,
  // and hears the result when it lands.
  await showBoard(page, board, Object.values(ids));
  await expect(page.getByTestId('app-view')).toHaveCount(3, { timeout: 15_000 });
  const clock = frame(page, time as string).locator('#server-time');
  await expect(clock).toHaveText(/^\d{4}-\d\d-\d\dT/, { timeout: 15_000 });
  const status = frame(page, money as string).locator('#status-bar');
  await expect(status).toContainText('Allocated: $100,000 / $100,000');
  await expect(frame(page, money as string).locator('input.slider')).toHaveCount(5);
  const heat = frame(page, cohort as string).locator('body');
  await expect(heat).toContainText('Nov 2026');
  await expect(heat).toContainText('100');

  // get-time: the button calls the tool through the board.
  const before = (await clock.textContent()) ?? '';
  await select(page, time as string);
  await frame(page, time as string)
    .locator('#get-time-btn')
    .click();
  await expect(clock).not.toHaveText(before);

  // budget-allocator: a bigger budget is allocated in full.
  await select(page, money as string);
  await frame(page, money as string)
    .locator('#budget-selector')
    .selectOption('250000');
  await expect(status).toContainText('$250,000 / $250,000');

  // cohort-heatmap: another metric is fetched from the server again.
  const retention = await heat.textContent();
  await select(page, cohort as string);
  await frame(page, cohort as string)
    .locator('select')
    .first()
    .selectOption('revenue');
  await expect.poll(() => heat.textContent()).not.toBe(retention);
  await expect(
    frame(page, cohort as string)
      .locator('select')
      .first(),
  ).toHaveValue('revenue');
});
