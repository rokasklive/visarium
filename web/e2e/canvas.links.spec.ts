import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Links (canvas/links): Alt-drag between things, drawn quietly, following
 * their ends, broken when an anchored node leaves the source, selectable and
 * removable. World origin is the canvas centre at zoom 1.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f7000';
const NOTE = '01a01640-6b72-7d60-968b-88be186f7001';
const FLOW = '01a01640-6b72-7d60-968b-88be186f7002';
const LIST = '01a01640-6b72-7d60-968b-88be186f7003';
const LINK = '01a01640-6b72-7d60-968b-88be186f7004';

const FLOW_SOURCE = 'flowchart LR\n  API --> Pay';
const at = (id: string, x: number, y: number, width: number, content: unknown) => ({
  id,
  transform: { x, y, width, height: 100, rotation: 0 },
  z: 1,
  revision: 0,
  content,
});
const items = () => [
  at(NOTE, -220, -150, 200, { kind: 'note', source: '### Overview\n\nThe checkout.' }),
  at(FLOW, 150, -150, 320, { kind: 'diagram', lang: 'mermaid', source: FLOW_SOURCE }),
  at(LIST, -220, 120, 200, {
    kind: 'checklist',
    title: 'Build',
    tasks: [{ id: 't1', text: 'Keys', state: 'todo' }],
  }),
];

interface Op {
  type: string;
  [k: string]: unknown;
}

async function stubBoard(page: Page, links: unknown[] = []) {
  const posted: Op[] = [];
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: { revision: 1, items: items(), groups: [], links, people: {} } }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  return posted;
}

type Hook = {
  layout(
    id: string,
  ):
    | { elements: Record<string, { x: number; y: number; width: number; height: number }> }
    | undefined;
  links(): {
    id: string;
    linkType: string;
    broken: boolean;
    from: { x: number; y: number };
    to: { x: number; y: number };
  }[];
  linkUi(): { hovered: string | null; selected: string | null };
  remote(body: unknown): void;
};

async function open(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  for (const id of [NOTE, FLOW, LIST]) {
    await page.waitForFunction(
      (i) =>
        (
          window as unknown as {
            Konva: { stages: { findOne(s: string): { className: string } | undefined }[] };
          }
        ).Konva.stages[0]?.findOne(`#${i}`)?.className === 'Image',
      id,
    );
  }
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The screen centre of a flowchart node (item at world (150, -150), 320 wide, top at -200). */
async function nodeCentre(page: Page, c: { x: number; y: number }, name: string) {
  const r = await page.evaluate(
    ([id, n]) =>
      (window as unknown as { __objects: Hook }).__objects.layout(id as string)?.elements[
        n as string
      ],
    [FLOW, name] as const,
  );
  if (!r) throw new Error(`no node ${name}`);
  return { x: c.x + 150 - 160 + r.x + r.width / 2, y: c.y - 150 - 50 + r.y + r.height / 2 };
}

async function altDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

const links = (page: Page) =>
  page.evaluate(() => (window as unknown as { __objects: Hook }).__objects.links());
const ui = (page: Page) =>
  page.evaluate(() => (window as unknown as { __objects: Hook }).__objects.linkUi());
const ofType = (posted: Op[], type: string) => posted.filter((op) => op.type === type);
const mid = (
  l: { from: { x: number; y: number }; to: { x: number; y: number } },
  c: { x: number; y: number },
) => ({
  x: c.x + (l.from.x + l.to.x) / 2,
  y: c.y + (l.from.y + l.to.y) / 2,
});

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('Alt-dragging from a note onto a flowchart node links them, typed by the source', async ({
  page,
}) => {
  const posted = await stubBoard(page);
  const c = await open(page);
  await altDrag(page, { x: c.x - 220, y: c.y - 160 }, await nodeCentre(page, c, 'Pay'));
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(1);
  expect(ofType(posted, 'link.add')[0]).toMatchObject({
    from: { itemId: NOTE, element: null },
    to: { itemId: FLOW, element: 'Pay' },
    linkType: 'describes',
  });
  expect(ofType(posted, 'item.transform'), 'the note did not move').toHaveLength(0);

  await altDrag(page, { x: c.x - 220, y: c.y + 100 }, { x: c.x + 150, y: c.y - 150 });
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(2);
  expect(ofType(posted, 'link.add')[1]).toMatchObject({
    from: { itemId: LIST },
    to: { itemId: FLOW },
    linkType: 'implements',
  });

  // Released over empty board: nothing.
  await altDrag(page, { x: c.x - 220, y: c.y - 160 }, { x: c.x + 100, y: c.y + 220 });
  await page.waitForTimeout(500);
  expect(ofType(posted, 'link.add')).toHaveLength(2);
});

test('links are quiet at rest, labelled on hover, and follow an item being dragged', async ({
  page,
}) => {
  await stubBoard(page, [
    {
      id: LINK,
      from: { itemId: NOTE, element: null },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    },
  ]);
  const c = await open(page);
  await expect.poll(async () => (await links(page)).length).toBe(1);
  expect(await ui(page)).toEqual({ hovered: null, selected: null });

  const [line] = await links(page);
  if (!line) throw new Error('no line');
  await page.mouse.move(mid(line, c).x, mid(line, c).y);
  await expect.poll(async () => (await ui(page)).hovered).toBe(LINK);
  await page.mouse.move(c.x + 300, c.y + 250);
  await expect.poll(async () => (await ui(page)).hovered).toBeNull();

  // Grab the flowchart (inside its drawn box: its top is at -200) and drag it down:
  // the line's end moves with it, before anything is committed.
  await page.mouse.move(c.x + 150, c.y - 200 + 15);
  await page.mouse.down();
  await page.mouse.move(c.x + 150, c.y - 200 + 115, { steps: 8 });
  const during = (await links(page))[0];
  await page.mouse.up();
  expect((during?.to.y ?? 0) - line.to.y).toBeGreaterThan(60);
});

test('renaming the anchored node breaks the link, and renaming it back mends it', async ({
  page,
}) => {
  await stubBoard(page, [
    {
      id: LINK,
      from: { itemId: NOTE, element: null },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    },
  ]);
  await open(page);
  await expect.poll(async () => (await links(page))[0]?.broken).toBe(false);
  const rename = (source: string) =>
    page.evaluate(
      ([id, src]) =>
        (window as unknown as { __objects: Hook }).__objects.remote({
          type: 'item.source',
          itemId: id,
          source: src,
        }),
      [FLOW, source] as const,
    );
  await rename('flowchart LR\n  API --> Payments');
  await expect.poll(async () => (await links(page))[0]?.broken).toBe(true);
  expect(await links(page)).toHaveLength(1);
  await rename(FLOW_SOURCE);
  await expect.poll(async () => (await links(page))[0]?.broken).toBe(false);
});

test('a link is selected by a click, retyped from its label, removed with Delete, and undone', async ({
  page,
}) => {
  const posted = await stubBoard(page, [
    {
      id: LINK,
      from: { itemId: NOTE, element: null },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    },
  ]);
  const c = await open(page);
  await expect.poll(async () => (await links(page)).length).toBe(1);
  const [line] = await links(page);
  if (!line) throw new Error('no line');
  const m = mid(line, c);

  await page.mouse.click(m.x, m.y);
  await expect.poll(async () => (await ui(page)).selected).toBe(LINK);
  // The label sits just above the line's midpoint. Paused, so the two clicks
  // are two clicks and not a double-click.
  await page.waitForTimeout(500);
  await page.mouse.click(m.x, m.y - 8);
  await expect.poll(() => ofType(posted, 'link.set').length).toBe(1);
  expect(ofType(posted, 'link.set')[0]).toMatchObject({ linkId: LINK, linkType: 'comments' });

  await page.keyboard.press('Delete');
  await expect.poll(() => ofType(posted, 'link.delete').length).toBe(1);
  await expect.poll(async () => (await links(page)).length).toBe(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(1);
  expect(ofType(posted, 'link.add')[0]).toMatchObject({
    linkId: LINK,
    linkType: 'comments',
    to: { element: 'Pay' },
  });
  await expect.poll(async () => (await links(page)).length).toBe(1);
});

test('deleting an item takes its links, and one undo brings both back', async ({ page }) => {
  const posted = await stubBoard(page, [
    {
      id: LINK,
      from: { itemId: NOTE, element: null },
      to: { itemId: FLOW, element: 'Pay' },
      linkType: 'describes',
    },
  ]);
  const c = await open(page);
  await page.mouse.click(c.x - 220, c.y - 160);
  await page.keyboard.press('Delete');
  await expect.poll(() => ofType(posted, 'item.delete').length).toBe(1);
  expect(ofType(posted, 'link.delete')).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(1);
  expect(ofType(posted, 'item.create')).toHaveLength(1);
  await expect.poll(async () => (await links(page)).length).toBe(1);
});
