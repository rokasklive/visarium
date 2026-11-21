import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * canvas/diagrams: "Diagram rendering is sandboxed". PlantUML's engine draws
 * into the live page before DOMPurify sees its SVG, so a source written by
 * another member must not be able to run script or reach the network while
 * it renders, on its own or through anything the engine inserts.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f7000';
const ITEM = '01a01640-6b72-7d60-968b-88be186f7001';

const sources = {
  'javascript link': '@startuml\nAlice -> Bob : [[javascript:alert(1) click]]\n@enduml',
  'remote image': '@startuml\nAlice -> Bob : <img:https://example.com/x.png>\n@enduml',
  'remote include': '@startuml\n!include https://example.com/x.puml\nAlice -> Bob\n@enduml',
  'icon font': '@startuml\nAlice -> Bob : <&star> hello\n@enduml',
  'svg in a link':
    '@startuml\nAlice -> Bob : [[https://example.com/"onmouseover="alert(1) x]]\n@enduml',
};

test('PlantUML sources run nothing and fetch nothing while they render', async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = [];
  const outside: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (!['localhost', '127.0.0.1'].includes(host) && !r.url().startsWith('data:')) {
      outside.push(r.url());
    }
  });
  await signedIn(page);
  let current = '';
  let drawn = 0;
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          {
            id: ITEM,
            transform: { x: 0, y: 0, width: 600, height: 300, rotation: 0 },
            z: 1,
            revision: 0,
            content: { kind: 'diagram', lang: 'plantuml', source: current },
          },
        ],
        groups: [],
        links: [],
        people: {},
      },
    }),
  );
  for (const [name, source] of Object.entries(sources)) {
    current = source;
    await page.goto(`/boards/${BOARD}`);
    await expect(page.getByTestId('canvas-stats')).toBeVisible();
    // The engine has run: drawn, or refused as a source error (an include).
    await page.waitForFunction(
      () =>
        ((window as unknown as { __objects?: { loaded?: { plantuml: number } } }).__objects?.loaded
          ?.plantuml ?? 0) > 0,
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(4_000);
    if (name !== 'remote include') {
      drawn += (await page.evaluate(
        (i) =>
          (window as unknown as { __objects?: { layout(id: string): unknown } }).__objects?.layout(
            i,
          ),
        ITEM,
      ))
        ? 1
        : 0;
    }
    // Hover everything that was drawn, in case a handler waits for the pointer.
    for (const el of await page.locator('svg *').all()) {
      await el.hover({ force: true, timeout: 200 }).catch(() => {});
    }
    expect.soft(dialogs, name).toEqual([]);
    expect.soft(outside, name).toEqual([]);
  }
  expect(drawn, 'the engine actually drew the sources it can read').toBeGreaterThan(0);
});
