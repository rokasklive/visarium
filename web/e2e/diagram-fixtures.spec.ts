import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * The renderer half of the anchor-name contract (ADR-0031, canvas/diagram-structure).
 * The server reads element names from diagram source; the browser reads them
 * from the rendered SVG (`elementsOf`). Both are checked against the same
 * fixtures: this spec for the browser, `server/tests/agent.rs` for the server.
 * A renderer upgrade that renames things fails here, not in a link.
 */

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'canvas-core',
  'fixtures',
  'diagrams',
);
const BOARD = '01a01640-6b72-7d60-968b-88be186f6000';
const ITEM = '01a01640-6b72-7d60-968b-88be186f6001';

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.mmd') || f.endsWith('.puml'))
  .map((file) => ({
    file,
    lang: file.endsWith('.mmd') ? 'mermaid' : 'plantuml',
    source: readFileSync(join(DIR, file), 'utf8'),
    elements: (
      JSON.parse(
        readFileSync(join(DIR, file.replace(/\.(mmd|puml)$/, '.elements.json')), 'utf8'),
      ) as {
        elements: string[];
      }
    ).elements,
  }));

test('the renderer names exactly the elements each fixture declares', async ({ page }) => {
  // One page, one diagram at a time, so each is in view; PlantUML's engine
  // loads once for the lot.
  test.setTimeout(180_000);
  await signedIn(page);
  let current = fixtures[0];
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
            content: { kind: 'diagram', lang: current?.lang, source: current?.source },
          },
        ],
        groups: [],
        links: [],
        people: {},
      },
    }),
  );
  const mismatches: string[] = [];
  for (const fixture of fixtures) {
    current = fixture;
    await page.goto(`/boards/${BOARD}`);
    await expect(page.getByTestId('canvas-stats')).toBeVisible();
    const handle = await page.waitForFunction(
      (i) =>
        (
          window as unknown as {
            __objects?: { layout(id: string): { elements: Record<string, unknown> } | undefined };
          }
        ).__objects?.layout(i),
      ITEM,
      { timeout: 60_000 },
    );
    const layout = (await handle.jsonValue()) as { elements: Record<string, unknown> };
    const got = Object.keys(layout.elements).sort();
    const want = [...fixture.elements].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches.push(
        `${fixture.file}: renderer ${JSON.stringify(got)}, fixture ${JSON.stringify(want)}`,
      );
    }
  }
  expect(mismatches).toEqual([]);
});
