import { type ChildProcess, spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { call, idsOf, newBoard, rectOf, SERVER, showBoard } from './apps-server';

/**
 * MCP servers as a source (canvas/app-sources, openspec canvas-apps-live
 * group 10), against a real server and a local MCP server on the official SDK
 * (fixtures/mcp/server.mjs): a person adds an app from it through "Add MCP
 * app…", the server runs its tool when its input changes, and its view calls
 * the server's tools through the board, which refuses one only the model may
 * call.
 *
 * Run with `just e2e-apps`, which starts the server with
 * VISARIUM_MCP_ALLOW=127.0.0.1 and sets VISARIUM_E2E_SERVER.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

const PORT = 18791;
let mcp: ChildProcess;

test.beforeAll(async () => {
  mcp = spawn('node', [new URL('./fixtures/mcp/server.mjs', import.meta.url).pathname, `${PORT}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ready) => mcp.stdout?.once('data', () => ready()));
});

test.afterAll(() => {
  mcp.kill();
});

test('an app from an MCP server runs its tool on the server and calls tools from its view', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'MCP');
  const b = { board };
  await call(request, 'item_create', { ...b, kind: 'note', source: '---\nage: 40\n---\n# Policy' });
  let id = await idsOf(page, board);
  await showBoard(page, board, [id('n1')]);

  // Add MCP app…: connect, and pick the one tool with a view.
  await page.getByRole('button', { name: 'MCP app…' }).click();
  const dialog = page.getByTestId('mcp-add');
  await dialog.getByLabel(/Server URL/).fill(`http://127.0.0.1:${PORT}/mcp`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  const tools = dialog.getByTestId('mcp-tools').getByRole('button');
  await expect(tools).toHaveCount(1);
  await expect(tools).toContainText('Insurance quote');
  await tools.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => call(request, 'board_read', b)).toMatch(/a1 +app "Insurance quote"/);

  // Fed the note's age, it runs on the server, nobody pressing Run.
  await call(request, 'link', {
    ...b,
    from: 'n1',
    to: 'a1',
    type: 'feeds',
    view: 'frontmatter',
    path: 'age',
    name: 'age',
  });
  await expect
    .poll(() => call(request, 'item_read', { ...b, ref: 'a1' }), { timeout: 20_000 })
    .toMatch(/premium":1200/);
  const read = await call(request, 'item_read', { ...b, ref: 'a1' });
  expect(read).toContain(`From MCP server http://127.0.0.1:${PORT}/mcp`);
  expect(read).toContain('tool quote (runs on the server');

  // Its view shows the result, and calls the server's tools once selected.
  id = await idsOf(page, board);
  await showBoard(page, board, [id('n1'), id('a1')]);
  const view = page.frameLocator(`[data-testid="app-view"][data-item-id="${id('a1')}"] iframe`);
  await expect(view.locator('#premium')).toHaveText('1200', { timeout: 15_000 });
  const r = await rectOf(page, id('a1'));
  await page.mouse.click(r.x + r.width / 2, r.y + 12);
  await page.waitForTimeout(600);
  await view.locator('#roll').click();
  await expect(view.locator('#said')).toHaveText('roll: 4');
  await view.locator('#secret').click();
  await expect(view.locator('#said')).toContainText('refused');
  await expect(view.locator('#said')).toContainText('not a tool this app');
});
