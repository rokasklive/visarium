import { expect, type Page, test } from '@playwright/test';
import {
  call,
  dblclickItem,
  fixture,
  idsOf,
  newBoard,
  SERVER,
  showBoard,
  xsrf,
} from './apps-server';

/**
 * An app under the hood (canvas/app-inspector, openspec canvas-apps-live
 * group 2), against a real server: double-click shows its source, what it
 * reads and what it leaves; every change there is an ordinary board change.
 *
 * Run with `just e2e-apps`, which starts the server and sets VISARIUM_E2E_SERVER.
 */

test.skip(!SERVER, 'needs a real server with an app sandbox: run `just e2e-apps`');

/** The premium calculator, declaring the inputs it expects. */
const premium = fixture('premium').replace(
  '<head>',
  '<head>\n<script type="application/json" id="visarium-inputs">[{ "name": "age", "description": "Insured\'s age" }, { "name": "sum" }]</script>',
);

type Snap = {
  revision: number;
  items: {
    id: string;
    ref: string;
    content: { html?: string; sourceRev?: number; literals?: unknown };
  }[];
  links: {
    id: string;
    from: { itemId: string };
    to: { itemId: string };
    linkType: string;
    path?: string | null;
    name?: string | null;
  }[];
};

async function snap(page: Page, board: string): Promise<Snap> {
  return (await (await page.request.get(`${SERVER}/api/boards/${board}/snapshot`)).json()) as Snap;
}

test('double-click shows an app under the hood, and every change there is a board change', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.request;
  await page.addInitScript(() => localStorage.setItem('visarium.labs.canvasApps', 'on'));
  await page.goto(SERVER);
  const board = await newBoard(page, 'Inspector');
  const b = { board };
  await call(request, 'item_create', { ...b, kind: 'note', source: '---\nage: 40\n---\n# Policy' });
  await call(request, 'app_create', { ...b, title: 'Premium', html: premium, right_of: 'n1' });
  await call(request, 'app_create', {
    ...b,
    title: 'Next',
    html: fixture('comparison'),
    right_of: 'a1',
  });
  await call(request, 'link', { ...b, from: 'n1', to: 'a1', type: 'feeds', view: 'frontmatter' });
  await call(request, 'link', { ...b, from: 'a1', to: 'a2', type: 'feeds', view: 'outputs' });
  const id = await idsOf(page, board);
  // Manual here: this spec runs a1 when it chooses, and reads it never run first.
  const manual = await request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers: await xsrf(page),
    data: {
      operations: ['a1', 'a2'].map((ref) => ({
        operationId: crypto.randomUUID(),
        baseRevision: 0,
        body: { type: 'app.set', itemId: id(ref), run: 'manual' },
      })),
    },
  });
  expect(manual.ok(), await manual.text()).toBe(true);
  await showBoard(page, board, [id('n1'), id('a1'), id('a2')]);

  const inspector = page.getByTestId('app-inspector');
  const inputs = inspector.getByTestId('inspector-inputs');
  const outputs = inspector.getByTestId('inspector-outputs');

  // Open and close: its source, what it reads, what it leaves; nothing changes.
  // Notes fit their height to their text once drawn: wait for the board to settle.
  let before = -1;
  await expect
    .poll(
      async () => {
        const was = before;
        before = (await snap(page, board)).revision;
        return before === was;
      },
      { intervals: [500] },
    )
    .toBe(true);
  await dblclickItem(page, id('a1'), true);
  await expect(inspector).toBeVisible();
  await expect(inspector.getByTestId('inspector-source')).toHaveValue(/const RATE = 30;/);
  await expect(inputs.getByTestId('input-row')).toHaveCount(1);
  await expect(inputs.getByLabel('Input n1.frontmatter: name')).toHaveValue('n1.frontmatter');
  await expect(inputs.getByTestId('input-value')).toHaveText('{"age":40}');
  await expect(inputs.getByTestId('input-declared')).toHaveCount(2);
  await expect(inputs.getByTestId('input-declared').first()).toContainText('age · not connected');
  await expect(outputs.getByTestId('output-status')).toHaveText('never run');
  await expect(outputs.getByTestId('output-feeds')).toHaveText('→ a2');
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  expect((await snap(page, board)).revision).toBe(before);

  // Not a document: refused with the reason, nothing saved, the inspector stays.
  await dblclickItem(page, id('a1'), true);
  const source = inspector.getByTestId('inspector-source');
  const original = await source.inputValue();
  await source.fill('<p>no</p>');
  await inspector.getByTestId('inspector-close').click();
  await expect(inspector.getByRole('alert')).toContainText('whole HTML document');
  await expect(inspector).toBeVisible();
  expect((await snap(page, board)).revision).toBe(before);

  // A quick edit: saved as one change; undo brings the old source back.
  await source.fill(original.replace('const RATE = 30;', 'const RATE = 31;'));
  await inspector.getByTestId('inspector-close').click();
  await expect(inspector).toHaveCount(0);
  await expect
    .poll(
      async () => (await snap(page, board)).items.find((i) => i.ref === 'a1')?.content.sourceRev,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await snap(page, board)).items.find((i) => i.ref === 'a1')?.content.html)
    .toContain('const RATE = 30;');

  // It runs once, live on the board, so that what changes next makes it stale.
  await expect(page.locator(`[data-testid="app-view"][data-item-id="${id('a1')}"]`)).toBeVisible();
  let ran = '';
  for (let tries = 0; tries < 50 && !ran.includes('Ran a1.'); tries++) {
    ran = await call(request, 'app_run', { ...b, ref: 'a1' });
    if (!ran.includes('Ran a1.')) await page.waitForTimeout(200);
  }
  expect(ran).toContain('Ran a1.');

  // Provenance at a glance.
  await dblclickItem(page, id('a1'), true);
  await expect(outputs.getByTestId('output-status')).toHaveText('fresh');
  await expect(outputs.getByTestId('output-credit')).toContainText(/^v1 · .+ for .+ · just now$/);

  // Narrow the link to one field, under a name: the value follows, the label says so.
  await inputs.getByLabel('n1.frontmatter: field').fill('age');
  await inputs.getByLabel('n1.frontmatter: field').press('Enter');
  await expect(inputs.getByTestId('input-value')).toHaveText('40');
  await inputs.getByLabel('Input n1.frontmatter: name').fill('age');
  await inputs.getByLabel('Input n1.frontmatter: name').press('Enter');
  await expect(inputs.getByLabel('Input age: name')).toBeVisible();
  await expect(inputs.getByTestId('input-declared')).toHaveCount(1);
  await expect(outputs.getByTestId('output-status')).toHaveText('stale (inputs changed)');

  // A literal: set, and named apart from every other input.
  await inputs.getByRole('button', { name: '+ Literal' }).click();
  await inputs.getByLabel('New literal: name').fill('rate');
  await inputs.getByLabel('New literal: value').fill('0.05');
  await inputs.getByRole('button', { name: 'Add' }).click();
  await expect(inputs.getByLabel('Input rate: name')).toBeVisible();
  await expect(inputs.getByLabel('rate: value')).toHaveValue('0.05');
  await inputs.getByLabel('Input rate: name').fill('age');
  await inputs.getByLabel('Input rate: name').press('Enter');
  await expect(inspector.getByRole('alert')).toContainText("already has an input named 'age'");

  // Remove the link; undo restores it with its field and name.
  await inputs.getByRole('button', { name: 'Remove age' }).click();
  await expect(inputs.getByLabel('Input age: name')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  const feedsA1 = (s: Snap) =>
    s.links.filter((l) => l.linkType === 'feeds' && l.to.itemId === id('a1'));
  await expect.poll(async () => feedsA1(await snap(page, board)).length).toBe(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => feedsA1(await snap(page, board)).map((l) => [l.path, l.name]))
    .toEqual([['age', 'age']]);

  // An agent reads the same: stale, because how its inputs are set up changed.
  expect(await call(request, 'item_read', { ...b, ref: 'a1' })).toContain('inputs changed');
});
