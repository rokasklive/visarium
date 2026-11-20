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
  // From the note's title, which stands for the whole note (canvas/text-anchors).
  await altDrag(page, { x: c.x - 300, y: c.y - 190 }, await nodeCentre(page, c, 'Pay'));
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(1);
  expect(ofType(posted, 'link.add')[0]).toMatchObject({
    from: { itemId: NOTE, element: null },
    to: { itemId: FLOW, element: 'Pay' },
    linkType: 'describes',
  });
  expect(ofType(posted, 'item.transform'), 'the note did not move').toHaveLength(0);
  expect(ofType(posted, 'item.source'), 'nor was it renamed').toHaveLength(0);

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

test('a link to a sequence participant lands on its head, and the whole lifeline is its anchor', async ({
  page,
}) => {
  const SEQ = '01a01640-6b72-7d60-968b-88be186f7005';
  const seq = at(SEQ, 150, 200, 320, {
    kind: 'diagram',
    lang: 'mermaid',
    source: 'sequenceDiagram\n  Alice->>Bob: hello\n  Bob-->>Alice: hi\n  Alice->>Bob: again',
  });
  const note = at(NOTE, 0, -200, 400, { kind: 'note', source: 'Above them both.' });
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [note, seq],
        groups: [],
        people: {},
        links: [
          {
            id: LINK,
            from: { itemId: NOTE, element: null },
            to: { itemId: SEQ, element: 'Bob' },
            linkType: 'describes',
          },
        ],
      },
    }),
  );
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await page.waitForFunction(
    (id) => !!(window as unknown as { __objects: Hook }).__objects?.layout(id)?.elements.Bob,
    SEQ,
  );
  const laid = await page.evaluate(
    (id) =>
      (window as unknown as { __objects: Hook }).__objects.layout(id) as unknown as {
        width: number;
        height: number;
        elements: Record<string, { x: number; y: number; width: number; height: number }>;
      },
    SEQ,
  );
  const bob = laid.elements.Bob;
  if (!bob) throw new Error('no Bob');
  // Head to foot: most of the drawing's height, not just the head box.
  expect(bob.height).toBeGreaterThan(laid.height * 0.75);
  // The arrow ends just above Bob's top (the lifeline's head), not partway
  // down. Read together: the item's height can settle while this runs.
  await expect
    .poll(async () => {
      const [l] = await links(page);
      const t = await page.evaluate(
        (id) =>
          (
            window as unknown as {
              __objects: { item(i: string): { transform: { y: number; height: number } } };
            }
          ).__objects.item(id).transform,
        SEQ,
      );
      const top = t.y - t.height / 2 + bob.y * (320 / laid.width);
      const gap = top - (l?.to.y ?? Number.NaN);
      return gap > 0 && gap < 12;
    })
    .toBe(true);
});

type Blocks = { index: number; name?: string; text: string; rect: { x: number; y: number; width: number; height: number } }[];

test('a paragraph is named when a link starts from it, in one undoable act', async ({ page }) => {
  const posted = await stubBoard(page);
  const c = await open(page);
  const laid = await page.evaluate(
    (id) =>
      (window as unknown as { __objects: { layout(id: string): { elements: Record<string, unknown>; blocks: Blocks } } }).__objects.layout(id),
    NOTE,
  );
  // The heading is an anchor by its slug; the paragraph is a block with no name yet.
  expect(Object.keys(laid.elements)).toEqual(['overview']);
  const para = laid.blocks.find((b) => b.text.includes('checkout'));
  if (!para) throw new Error('no paragraph block');
  expect(para.name).toBeUndefined();
  // NOTE sits at world (-220, -150), 200 wide: its top-left is (-320, -200).
  const from = { x: c.x - 320 + para.rect.x + 10, y: c.y - 200 + para.rect.y + para.rect.height / 2 };
  await altDrag(page, from, await nodeCentre(page, c, 'Pay'));
  await expect.poll(() => ofType(posted, 'link.add').length).toBe(1);
  const source = ofType(posted, 'item.source')[0]?.source as string;
  const name = /The checkout\. (\^[0-9a-z]{4})$/.exec(source)?.[1];
  expect(name, source).toBeTruthy();
  expect(ofType(posted, 'link.add')[0]).toMatchObject({
    from: { itemId: NOTE, element: name },
    to: { itemId: FLOW, element: 'Pay' },
  });
  // The marker is in the source, not in the drawing; the paragraph is now an anchor.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as { __objects: { layout(id: string): { blocks: Blocks } } }).__objects
            .layout(id)
            .blocks.map((b) => [b.name ?? null, b.text]),
        NOTE,
      ),
    )
    .toContainEqual([name, 'The checkout.']);
  // One undo takes back the link and the name together.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await links(page)).length).toBe(0);
  const restored = await page.evaluate(
    (id) =>
      (window as unknown as { __objects: { item(i: string): { content: { source: string } } } }).__objects.item(id).content.source,
    NOTE,
  );
  expect(restored).toBe('### Overview\n\nThe checkout.');
});

test('a link to a passage that is gone is broken, and heals when it comes back', async ({ page }) => {
  await stubBoard(page, [
    { id: LINK, from: { itemId: NOTE, element: '^gone' }, to: { itemId: FLOW, element: 'Pay' }, linkType: 'describes' },
  ]);
  await open(page);
  await expect.poll(async () => (await links(page))[0]?.broken).toBe(true);
  await page.evaluate(
    ([id]) =>
      (window as unknown as { __objects: Hook }).__objects.remote({
        type: 'item.source',
        itemId: id,
        source: '### Overview\n\nThe checkout. ^gone',
      }),
    [NOTE],
  );
  await expect.poll(async () => (await links(page))[0]?.broken, { timeout: 10_000 }).toBe(false);
});
