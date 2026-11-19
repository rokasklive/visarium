import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Notes, diagrams and checklists on the board (canvas/notes, canvas/diagrams,
 * canvas/checklists; design D2-D4): laid out off-screen, rasterised into the
 * bitmap cache, drawn by Konva.
 *
 * Geometry is read through the dev server's `window.__objects` hook, because a
 * drawn bitmap cannot say where its checkbox is and the specs need exactly
 * that: real layout, in a real engine, at the versions installed.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f5000';
const id = (n: number) => `01a01640-6b72-7d60-968b-88be186f50${String(n).padStart(2, '0')}`;
const NOTE = id(1);
const LIST = id(2);
const FLOW = id(3);
const SEQ = id(4);
const CLASS = id(5);
const PUML_SEQ = id(6);
const PUML_CLASS = id(7);

type Content = Record<string, unknown>;

function item(itemId: string, x: number, y: number, content: Content, width = 320) {
  return {
    id: itemId,
    transform: { x, y, width, height: 120, rotation: 0 },
    z: 1,
    revision: 0,
    content,
  };
}

interface Posted {
  type: string;
  itemId?: string;
  transform?: { x: number; y: number; width: number; height: number; rotation: number };
}

async function stubBoard(page: Page, items: ReturnType<typeof item>[]) {
  const posted: Posted[] = [];
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.hostname !== 'localhost') outside.push(r.url());
  });
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: { revision: 1, items, groups: [], links: [], people: {} } }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Posted }[] };
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  return { posted, outside };
}

type Debug = {
  width: number;
  height: number;
  stale: boolean;
  error?: string;
  hits: {
    kind: string;
    index?: number;
    taskId?: string;
    href?: string;
    rect: { x: number; y: number; width: number; height: number };
  }[];
  elements: Record<string, { x: number; y: number; width: number; height: number }>;
};

/** An object's layout once it has one. */
async function layoutOf(page: Page, itemId: string, timeout = 30_000): Promise<Debug> {
  const handle = await page.waitForFunction(
    (i) =>
      (window as unknown as { __objects?: { layout(id: string): unknown } }).__objects?.layout(i),
    itemId,
    { timeout },
  );
  return (await handle.jsonValue()) as Debug;
}

const loaded = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __objects: { loaded: Record<string, number> } }).__objects.loaded,
  );

async function open(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a note lays out its Markdown, with its checkboxes and links as hit regions', async ({
  page,
}) => {
  await stubBoard(page, [
    item(NOTE, 0, 0, {
      kind: 'note',
      source:
        '### Payment adapter\n\nSee the [runbook](https://example.com/runbook).\n\n- [x] Interface agreed\n- [ ] Agree the timeout',
    }),
  ]);
  await open(page);
  const note = await layoutOf(page, NOTE);
  expect(note.width).toBe(320);
  expect(note.height).toBeGreaterThan(80);
  const boxes = note.hits.filter((h) => h.kind === 'checkbox');
  expect(boxes.map((b) => b.index)).toEqual([0, 1]);
  // Drawn boxes, 14 units square, one under the other, inside the note.
  for (const b of boxes) {
    expect(b.rect.width).toBeCloseTo(14, 0);
    expect(b.rect.x).toBeGreaterThanOrEqual(0);
    expect(b.rect.y + b.rect.height).toBeLessThanOrEqual(note.height);
  }
  expect((boxes[1]?.rect.y ?? 0) > (boxes[0]?.rect.y ?? 0)).toBe(true);
  expect(note.hits.find((h) => h.kind === 'link')?.href).toBe('https://example.com/runbook');
});

test('a checklist lays out each task with its own state marker and text', async ({ page }) => {
  await stubBoard(page, [
    item(LIST, 0, 0, {
      kind: 'checklist',
      title: 'Build the payment adapter',
      tasks: [
        { id: 't1', text: 'Define the adapter interface', state: 'done' },
        { id: 't2', text: 'Idempotency key on every charge', state: 'doing' },
        {
          id: 't3',
          text: 'Retry with exponential backoff (waiting on the timeout)',
          state: 'blocked',
        },
      ],
    }),
  ]);
  await open(page);
  const list = await layoutOf(page, LIST);
  const markers = list.hits.filter((h) => h.kind === 'task-state');
  expect(markers.map((m) => m.taskId)).toEqual(['t1', 't2', 't3']);
  for (const m of markers) expect(m.rect.width).toBeCloseTo(16, 0);
  expect(list.hits.filter((h) => h.kind === 'task-text').map((m) => m.taskId)).toEqual([
    't1',
    't2',
    't3',
  ]);
  expect(list.hits.some((h) => h.kind === 'title')).toBe(true);
});

test('diagrams expose their named elements, pinned to the installed renderers', async ({
  page,
}) => {
  // The first PlantUML render loads an 8.5 MB engine in a cold dev server.
  test.setTimeout(90_000);
  // All in view: like images, objects are only laid out once they are visible.
  await stubBoard(page, [
    item(
      FLOW,
      0,
      -220,
      {
        kind: 'diagram',
        lang: 'mermaid',
        source:
          'flowchart LR\n  Client([Web client]) --> API[Checkout API]\n  API --> Pay[Payment adapter]\n  Pay --> Provider{{Payment provider}}',
      },
      600,
    ),
    item(SEQ, -350, 0, {
      kind: 'diagram',
      lang: 'mermaid',
      source:
        'sequenceDiagram\n  participant Agent\n  participant Board\n  Agent->>Board: add diagram',
    }),
    item(CLASS, 350, 0, {
      kind: 'diagram',
      lang: 'mermaid',
      source: 'classDiagram\n  class Board\n  class Item\n  Board "1" *-- "many" Item',
    }),
    item(PUML_SEQ, -350, 220, {
      kind: 'diagram',
      lang: 'plantuml',
      source:
        '@startuml\nparticipant Provider\nparticipant API\ndatabase Orders\nProvider -> API : payment.succeeded\nAPI -> Orders : mark paid\n@enduml',
    }),
    item(PUML_CLASS, 350, 220, {
      kind: 'diagram',
      lang: 'plantuml',
      source: '@startuml\nclass Board\nclass Item\nBoard "1" *-- "many" Item\n@enduml',
    }),
  ]);
  await open(page);
  const names = async (itemId: string) =>
    Object.keys((await layoutOf(page, itemId, 60_000)).elements).sort();
  expect(await names(FLOW)).toEqual(['API', 'Client', 'Pay', 'Provider']);
  expect(await names(SEQ)).toEqual(['Agent', 'Board']);
  expect(await names(CLASS)).toEqual(['Board', 'Item']);
  expect(await names(PUML_SEQ)).toEqual(['API', 'Orders', 'Provider']);
  expect(await names(PUML_CLASS)).toEqual(['Board', 'Item']);
  const flow = await layoutOf(page, FLOW);
  for (const r of Object.values(flow.elements)) {
    expect(r.width).toBeGreaterThan(10);
    expect(r.x + r.width).toBeLessThanOrEqual(flow.width + 1);
  }
});

test('an image-only board loads no renderer; a PlantUML board loads its engine once', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await stubBoard(page, []);
  await open(page);
  await page.waitForTimeout(500);
  expect(await loaded(page)).toEqual({ markdown: 0, mermaid: 0, plantuml: 0 });

  await stubBoard(page, [
    item(PUML_SEQ, 0, 0, {
      kind: 'diagram',
      lang: 'plantuml',
      source: '@startuml\nA -> B\n@enduml',
    }),
    item(PUML_CLASS, 400, 0, {
      kind: 'diagram',
      lang: 'plantuml',
      source: '@startuml\nclass A\n@enduml',
    }),
  ]);
  const engines: string[] = [];
  page.on('request', (r) => {
    // The dev server also serves the `?url` import itself as a tiny module;
    // only the engine's own two scripts count.
    if (
      /@plantuml\/core\/(plantuml|viz-global)\.js$/.test(r.url().split('?')[0] ?? '') &&
      !r.url().includes('?url')
    ) {
      engines.push(r.url());
    }
  });
  await open(page);
  await layoutOf(page, PUML_SEQ, 60_000);
  await layoutOf(page, PUML_CLASS, 60_000);
  expect((await loaded(page)).plantuml).toBe(1);
  expect((await loaded(page)).mermaid).toBe(0);
  expect(engines.filter((u) => u.includes('viz-global'))).toHaveLength(1);
  expect(engines.filter((u) => u.includes('plantuml.js'))).toHaveLength(1);
});

const apply = (page: Page, body: unknown, how: 'apply' | 'remote' = 'apply') =>
  page.evaluate(
    ([b, h]) =>
      (window as unknown as { __objects: Record<string, (x: unknown) => void> }).__objects[h]?.(b),
    [body, how] as const,
  );

const itemOf = (page: Page, itemId: string) =>
  page.evaluate(
    (i) =>
      (
        window as unknown as {
          __objects: { item(id: string): { transform: { y: number; height: number } } };
        }
      ).__objects.item(i),
    itemId,
  );

test('a diagram whose source stops parsing keeps its last good drawing, marked', async ({
  page,
}) => {
  await stubBoard(page, [
    item(
      FLOW,
      0,
      -150,
      { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  API --> Pay' },
      400,
    ),
    item(SEQ, 0, 150, { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  API -->' }),
  ]);
  await open(page);
  const good = await layoutOf(page, FLOW);
  expect(good.stale).toBe(false);

  await apply(page, {
    type: 'item.source',
    itemId: FLOW,
    source: 'flowchart LR\n  API --> Pay -->',
  });
  await expect.poll(async () => (await layoutOf(page, FLOW)).stale).toBe(true);
  const kept = await layoutOf(page, FLOW);
  expect(Object.keys(kept.elements).sort(), 'the last good drawing, anchors and all').toEqual([
    'API',
    'Pay',
  ]);
  expect(kept.error).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        (i) =>
          (
            window as unknown as { Konva: { stages: { findOne(s: string): unknown }[] } }
          ).Konva.stages[0]?.findOne(`#stale-${i}`) !== undefined,
        FLOW,
      ),
    )
    .toBe(true);

  // One that never rendered shows its source, so nothing on the board is invisible.
  const never = await layoutOf(page, SEQ);
  expect(never.stale).toBe(true);
  expect(never.height).toBeGreaterThan(20);
});

test("only the client whose change it was writes an object's new height", async ({ page }) => {
  const { posted } = await stubBoard(page, [
    item(NOTE, 0, 0, { kind: 'note', source: 'One line.' }),
  ]);
  await open(page);
  const before = await layoutOf(page, NOTE);
  const transforms = () =>
    posted.filter((op) => op.type === 'item.transform' && op.itemId === NOTE);

  // Someone else's change: drawn at the new height here, but nothing written.
  await apply(
    page,
    { type: 'item.source', itemId: NOTE, source: 'One line.\n\nTwo.\n\nThree.\n\nFour.' },
    'remote',
  );
  await expect
    .poll(async () => (await layoutOf(page, NOTE)).height)
    .toBeGreaterThan(before.height + 40);
  await page.waitForTimeout(1500);
  expect(transforms(), 'a remote change writes no height').toHaveLength(0);

  // My change: exactly one transform, with the same top edge.
  const top = (t: { y: number; height: number }) => t.y - t.height / 2;
  const startTop = top((await itemOf(page, NOTE)).transform);
  await apply(page, {
    type: 'item.source',
    itemId: NOTE,
    source: 'One line.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.',
  });
  await expect.poll(() => transforms().length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(1000);
  expect(transforms()).toHaveLength(1);
  const written = transforms()[0]?.transform;
  if (!written) throw new Error('no transform');
  expect(top(written)).toBeCloseTo(startTop, 3);
  expect(written.height).toBeCloseTo((await layoutOf(page, NOTE)).height, 0);
});

test('rendering runs nothing from the source and fetches nothing from elsewhere', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { outside } = await stubBoard(page, [
    item(NOTE, -350, 0, {
      kind: 'note',
      source:
        '<script>window.__pwned = 1</script>\n\n<img src="x" onerror="window.__pwned = 2">\n\n![remote](https://evil.example/pixel.png)\n\n<a href="javascript:window.__pwned=3">x</a> and <a href="https://example.com">fine</a>',
    }),
    item(FLOW, 0, 0, {
      kind: 'diagram',
      lang: 'mermaid',
      source:
        'flowchart LR\n  A --> B\n  click A callback "Tooltip"\n  click B href "javascript:window.__pwned=4"',
    }),
    item(PUML_SEQ, 350, 0, {
      kind: 'diagram',
      lang: 'plantuml',
      source: '@startuml\n!include https://evil.example/x.puml\nA -> B\n@enduml',
    }),
  ]);
  await open(page);
  const note = await layoutOf(page, NOTE);
  await layoutOf(page, FLOW);
  await layoutOf(page, PUML_SEQ, 60_000);
  await page.waitForTimeout(1000);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(
    note.hits.filter((h) => h.kind === 'link').map((h) => h.href),
    'only safe links survive',
  ).toEqual(['https://example.com']);
  expect(outside).toEqual([]);
});
