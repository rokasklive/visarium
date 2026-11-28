import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * The fixture apps of the insurance scenario (openspec canvas-apps-poc 7.1),
 * each alone: a bare host page plays the MCP Apps bridge to one of them in a
 * real iframe, runs it and records what it publishes and proposes. The board,
 * the sandbox origin and the server's checks are the scenario spec's subject
 * (canvas.apps.scenario.spec.ts).
 */

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/apps/${name}.html`, import.meta.url), 'utf8');

const HOST = `<!doctype html><html><body><iframe id="app" src="http://sandbox.test/app"></iframe><script>
window.calls = [];
const frame = document.getElementById('app');
const send = (m) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...m }, '*');
window.ready = new Promise((ready) => {
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0' || !m.method) return;
    window.calls.push({ method: m.method, params: m.params });
    if (m.method === 'ui/initialize') send({ id: m.id, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostContext: {} } });
    else if (m.method === 'ui/notifications/initialized') ready();
    else if (m.id !== undefined) send({ id: m.id, result: {} });
  });
});
window.run = (args) => send({ method: 'visarium/notifications/run', params: { arguments: args } });
</script></body></html>`;

async function host(page: Page, app: string) {
  await page.route('http://host.test/', (r) => r.fulfill({ contentType: 'text/html', body: HOST }));
  await page.route('http://sandbox.test/app', (r) =>
    r.fulfill({ contentType: 'text/html', body: fixture(app) }),
  );
  await page.goto('http://host.test/');
  await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready);
  return {
    run: (args: unknown) =>
      page.evaluate((a) => (window as unknown as { run(a: unknown): void }).run(a), args),
    /** The params of every call of `method` so far. */
    calls: (method: string) =>
      page.evaluate(
        (m) =>
          (window as unknown as { calls: { method: string; params: unknown }[] }).calls
            .filter((c) => c.method === m)
            .map((c) => c.params),
        method,
      ),
  };
}

test('the premium calculator prices the fed note and publishes premium and quote', async ({
  page,
}) => {
  const app = await host(page, 'premium');
  await app.run({ 'n1.frontmatter': { age: 40, expected_premium: 1200 } });
  await expect
    .poll(() => app.calls('visarium/outputs/publish'))
    .toEqual([{ outputs: { premium: 1200, expected: 1200 }, text: 'Premium 1200' }]);
  await expect(page.frameLocator('#app').locator('#premium')).toHaveText('1200');

  await app.run({});
  await expect
    .poll(async () => (await app.calls('visarium/outputs/publish'))[1])
    .toMatchObject({ status: 'error', outputs: {} });
});

test('the comparison judges premium against quote and sets t1 to match', async ({ page }) => {
  const app = await host(page, 'comparison');
  await app.run({ 'a1.outputs': { premium: 1200, expected: 1200 } });
  await expect
    .poll(() => app.calls('visarium/items/propose'))
    .toEqual([{ changes: [{ type: 'task.set', taskId: 't1', state: 'done' }] }]);
  expect((await app.calls('visarium/outputs/publish'))[0]).toMatchObject({
    outputs: { verdict: 'match', diff: 0 },
  });

  await app.run({ 'a1.outputs': { premium: 1350, expected: 1200 } });
  await expect
    .poll(async () => (await app.calls('visarium/items/propose'))[1])
    .toEqual({ changes: [{ type: 'task.set', taskId: 't1', state: 'blocked' }] });
  await expect(page.frameLocator('#app').locator('#verdict')).toHaveText('mismatch');
});

test('the rack plan draws its JSON block with no inputs and publishes what is free', async ({
  page,
}) => {
  const app = await host(page, 'rack');
  const view = page.frameLocator('#app');
  await expect(view.locator('#title')).toHaveText('Rack A1');
  // One strip per device, each wearing its kind's series colour, and a legend.
  await expect(view.locator('svg rect[class^="series-"]')).toHaveCount(6);
  await expect(view.locator('.legend li')).toHaveText(['Network', 'Compute', 'Storage', 'Power']);
  await app.run({});
  await expect
    .poll(() => app.calls('visarium/outputs/publish'))
    .toEqual([{ outputs: { units: 12, used: 11, free: 1 }, text: 'Rack A1: 11 of 12 U used' }]);
});

test('the sales chart draws a fed table as series and publishes the totals', async ({ page }) => {
  const app = await host(page, 'sales');
  const table = {
    headers: ['Quarter', 'North', 'South'],
    rows: [
      { Quarter: 'Q1', North: '120', South: '80' },
      { Quarter: 'Q2', North: '150', South: '95' },
    ],
  };
  await app.run({ sales: table });
  await expect
    .poll(() => app.calls('visarium/outputs/publish'))
    .toEqual([{ outputs: { totals: { North: 270, South: 175 } }, text: 'North 270, South 175' }]);
  const view = page.frameLocator('#app');
  await expect(view.locator('#chart')).not.toHaveAttribute('hidden');
  await expect(view.locator('rect.series-1')).toHaveCount(2);
  await expect(view.locator('rect.series-2')).toHaveCount(2);
  await expect(view.locator('.legend li')).toHaveText(['North', 'South']);
  await expect(view.locator('#table td.num')).toHaveText(['120', '80', '150', '95']);

  // Fed without a name, it takes the first table of the first tables input.
  await app.run({ 'n1.tables': [table] });
  await expect.poll(async () => (await app.calls('visarium/outputs/publish')).length).toBe(2);

  await app.run({});
  await expect
    .poll(async () => (await app.calls('visarium/outputs/publish'))[2])
    .toMatchObject({ status: 'error', outputs: {} });
  await expect(view.locator('#empty')).toBeVisible();
  await expect(view.locator('#chart')).toHaveAttribute('hidden');
});

/**
 * The off-grid cabin board (a demo of canvas apps): five apps chained the way
 * the board links them, each fed what the one before published. With the
 * starting plan two of the four checks fail; the verdict says which tasks to
 * block.
 */
test('the cabin apps chain from an appliance table to a checklist verdict', async ({ browser }) => {
  const appliances = {
    headers: ['Appliance', 'Category', 'Watts', 'Hours'],
    rows: [
      ['Fridge', 'Kitchen', '45', '24'],
      ['Induction hob', 'Kitchen', '1800', '0.75'],
      ['LED lights', 'Light', '60', '5'],
      ['Laptop', 'Work', '65', '6'],
      ['Starlink', 'Work', '50', '10'],
      ['Water pump', 'Water', '400', '0.5'],
      ['Ceiling fan', 'Comfort', '35', '8'],
      ['Electric blanket', 'Comfort', '60', '6'],
    ].map(([a, c, w, h]) => ({ Appliance: a, Category: c, Watts: w, Hours: h })),
  };
  const hours = [1.8, 2.6, 3.6, 4.6, 5.2, 5.6, 5.8, 5.2, 4.2, 3.0, 1.9, 1.5];
  const sun = {
    headers: ['Month', 'Sun hours'],
    rows: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
      (m, i) => ({ Month: m, 'Sun hours': String(hours[i]) }),
    ),
  };
  const site = { panels: 8, panel_watts: 400, battery_kwh: 10, roof_width_m: 9, roof_depth_m: 5 };
  type Published = { outputs: Record<string, unknown> };
  const run = async (app: string, args: unknown) => {
    const page = await browser.newPage();
    const h = await host(page, app);
    await h.run(args);
    await expect.poll(async () => (await h.calls('visarium/outputs/publish')).length).toBe(1);
    const published = (await h.calls('visarium/outputs/publish'))[0] as Published;
    const proposed = await h.calls('visarium/items/propose');
    await page.close();
    return { ...published, proposed };
  };
  const load = await run('cabin-load', { appliances });
  expect(load.outputs).toMatchObject({ loadWh: 4460, largest: { name: 'Induction hob' } });
  const solar = await run('cabin-solar', { site, sun, load: load.outputs });
  expect(solar.outputs).toMatchObject({
    worstMonth: 'Dec',
    worstRatio: 0.84,
    shortMonths: ['Dec'],
  });
  const battery = await run('cabin-battery', { battery_kwh: 10, load_wh: 4460, reserve: 0.2 });
  expect(battery.outputs).toEqual({ days: 1.8, usableWh: 8000 });
  const roof = await run('cabin-roof', { site });
  expect(roof.outputs).toEqual({ fits: true, max: 12, wanted: 8 });
  const verdict = await run('cabin-verdict', {
    solar: solar.outputs,
    battery: battery.outputs,
    load: load.outputs,
    roof: roof.outputs,
    max_appliance_w: 2000,
  });
  expect(verdict.outputs.ready).toBe(false);
  expect(verdict.proposed).toEqual([
    {
      changes: [
        { type: 'task.set', taskId: 't1', state: 'blocked' },
        { type: 'task.set', taskId: 't2', state: 'blocked' },
        { type: 'task.set', taskId: 't3', state: 'done' },
        { type: 'task.set', taskId: 't4', state: 'done' },
      ],
    },
  ]);
});
