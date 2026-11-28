import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Light and dark (appearance/theme, canvas/diagrams): System by default and
 * live, a choice in Settings that sticks to this device, applied before the
 * first paint, and the board's diagrams drawn again in the new theme.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f6000';
const FLOW = '01a01640-6b72-7d60-968b-88be186f6001';
const PUML = '01a01640-6b72-7d60-968b-88be186f6002';

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

/** Settings asks for these whatever section a spec is about. */
async function stubSettings(page: Page) {
  for (const path of ['/api/sessions', '/api/accounts', '/api/invitations', '/api/agent-tokens']) {
    await page.route(
      (url) => url.pathname === path,
      (route) => route.fulfill({ json: [] }),
    );
  }
  await page.route('**/api/accounts/me/identities', (route) =>
    route.fulfill({ json: { hasPassword: true, identities: [] } }),
  );
}

async function stubBoard(page: Page) {
  const item = (id: string, x: number, content: Record<string, unknown>) => ({
    id,
    transform: { x, y: 0, width: 320, height: 120, rotation: 0 },
    z: 1,
    revision: 0,
    content,
  });
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          item(FLOW, -200, {
            kind: 'diagram',
            lang: 'mermaid',
            source: 'flowchart LR\n  API --> Pay',
          }),
          item(PUML, 200, {
            kind: 'diagram',
            lang: 'plantuml',
            source: '@startuml\nAlice -> Bob : hi\n@enduml',
          }),
        ],
        groups: [],
        links: [],
        people: {},
      },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: unknown }[] };
    await route.fulfill({ json: { revision: 2, operations: body.operations.map((o) => o.body) } });
  });
}

type Drawn = { key: string; svg: string; stale: boolean };

/** A diagram's drawing once it is drawn for `wanted`. */
async function drawnIn(page: Page, itemId: string, wanted: 'light' | 'dark'): Promise<Drawn> {
  const handle = await page.waitForFunction(
    ([i, t]) => {
      const d = (
        window as unknown as { __objects?: { layout(id: string): Drawn | undefined } }
      ).__objects?.layout(i as string);
      return d?.key.startsWith(`${t}|`) && !d.stale ? d : undefined;
    },
    [itemId, wanted],
    { timeout: 60_000 },
  );
  return (await handle.jsonValue()) as Drawn;
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a new device follows a light-mode computer', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await stubSettings(page);
  await page.goto('/settings');
  expect(await theme(page)).toBe('light');
  await expect(page.getByTestId('theme-setting').getByLabel('System')).toBeChecked();
});

test('Dark, picked in Settings, applies at once and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await stubSettings(page);
  await page.goto('/settings');
  await page.getByTestId('theme-setting').getByText('Dark', { exact: true }).click();
  expect(await theme(page)).toBe('dark');
  await page.reload();
  expect(await theme(page)).toBe('dark');
  await expect(page.getByTestId('theme-setting').getByLabel('Dark')).toBeChecked();

  // An explicit choice ignores the system.
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await theme(page)).toBe('dark');
});

test('the theme is on the page before anything is drawn', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('visarium.theme', 'light');
    // The body is the first thing that could paint; record the theme when it exists.
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      (window as unknown as { __firstTheme?: string | undefined }).__firstTheme =
        document.documentElement.dataset.theme;
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await stubSettings(page);
  await page.goto('/settings');
  expect(
    await page.evaluate(() => (window as unknown as { __firstTheme?: string }).__firstTheme),
  ).toBe('light');
});

test('on System, an open board and its diagrams follow the computer to light', async ({ page }) => {
  // The first PlantUML render loads an 8.5 MB engine in a cold dev server.
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await stubBoard(page);
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const flowDark = await drawnIn(page, FLOW, 'dark');
  const pumlDark = await drawnIn(page, PUML, 'dark');

  await page.emulateMedia({ colorScheme: 'light' });
  // The media query's change event is delivered asynchronously.
  await expect.poll(() => theme(page)).toBe('light');
  const flowLight = await drawnIn(page, FLOW, 'light');
  const pumlLight = await drawnIn(page, PUML, 'light');
  expect(flowLight.svg).not.toBe(flowDark.svg);
  expect(pumlLight.svg).not.toBe(pumlDark.svg);
});

test('canvas apps are a Labs experiment, off until turned on on this device', async ({ page }) => {
  await signedIn(page);
  await stubSettings(page);
  await page.goto('/settings');
  const toggle = page.getByTestId('canvas-apps-setting').getByRole('checkbox');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.reload();
  await expect(page.getByTestId('canvas-apps-setting').getByRole('checkbox')).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('visarium.labs.canvasApps'))).toBe('on');
  await page.getByTestId('canvas-apps-setting').getByRole('checkbox').uncheck();
  expect(await page.evaluate(() => localStorage.getItem('visarium.labs.canvasApps'))).toBeNull();
});
