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
