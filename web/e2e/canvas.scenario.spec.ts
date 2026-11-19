import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * The checkout-service board from the Objects Lab, end to end: a flowchart, the
 * note that explains it, a comment and a checklist pointing at its `Pay` node,
 * and a PlantUML sequence pointing at `Provider`. Everything the change is for,
 * on one board, through every layer the browser has (board-objects-and-links,
 * task 8.1).
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f9000';
const id = (n: number) => `01a01640-6b72-7d60-968b-88be186f90${String(n).padStart(2, '0')}`;
const FLOW = id(1);
const OVERVIEW = id(2);
const PAY_NOTES = id(3);
const BUILD = id(4);
const WEBHOOK = id(5);

const item = (itemId: string, x: number, y: number, width: number, content: unknown) => ({
  id: itemId,
  transform: { x, y, width, height: 120, rotation: 0 },
  z: 1,
  revision: 0,
  content,
});

const BOARD_ITEMS = [
  item(FLOW, 60, -170, 480, {
    kind: 'diagram',
    lang: 'mermaid',
    source:
      'flowchart LR\n  Client([Web client]) --> API[Checkout API]\n  API --> Orders[(Orders DB)]\n  API --> Pay[Payment adapter]\n  Pay --> Provider{{Payment provider}}\n  Provider -. webhook .-> API',
  }),
  item(OVERVIEW, -330, -170, 200, {
    kind: 'note',
    source:
      "### Checkout service\n\nAn order is marked paid only when the provider's webhook arrives.",
  }),
  item(PAY_NOTES, -330, 90, 200, {
    kind: 'note',
    source: '### Payment adapter\n\n- One idempotency key per attempt\n- [ ] Agree the timeout',
  }),
  item(BUILD, -60, 90, 220, {
    kind: 'checklist',
    title: 'Build the payment adapter',
    tasks: [
      {
        id: 't1',
        text: 'Define the adapter interface',
        state: 'done',
        by: id(90),
        at: '2026-11-18T09:12:00Z',
      },
      { id: 't2', text: 'Idempotency key on every charge', state: 'doing' },
      { id: 't3', text: 'Verify webhook signatures', state: 'todo' },
    ],
  }),
  item(WEBHOOK, 230, 90, 220, {
    kind: 'diagram',
    lang: 'plantuml',
    source:
      '@startuml\nparticipant Provider\nparticipant API\ndatabase Orders\nProvider -> API : payment.succeeded\nAPI -> Orders : mark paid\n@enduml',
  }),
];

const BOARD_LINKS = [
  {
    id: id(11),
    from: { itemId: OVERVIEW, element: null },
    to: { itemId: FLOW, element: null },
    linkType: 'describes',
  },
  {
    id: id(12),
    from: { itemId: PAY_NOTES, element: null },
    to: { itemId: FLOW, element: 'Pay' },
    linkType: 'comments',
  },
  {
    id: id(13),
    from: { itemId: BUILD, element: null },
    to: { itemId: FLOW, element: 'Pay' },
    linkType: 'implements',
  },
  {
    id: id(14),
    from: { itemId: WEBHOOK, element: null },
    to: { itemId: FLOW, element: 'Provider' },
    linkType: 'describes',
  },
];

type Hook = {
  layout(id: string): { elements: Record<string, unknown>; stale: boolean } | undefined;
  links(): { id: string; broken: boolean }[];
  item(id: string): { content: { tasks?: { id: string; state: string }[] } } | undefined;
};

async function hook<T>(page: Page, fn: (h: Hook, arg: string) => T, arg = ''): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const h = (window as unknown as { __objects: Hook }).__objects;
      return new Function('h', 'a', `return (${source})(h, a)`)(h, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

test('the checkout-service board renders, anchors every link, and works from the board', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signedIn(page);
  const posted: { type: string; [k: string]: unknown }[] = [];
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: BOARD_ITEMS,
        groups: [],
        links: BOARD_LINKS,
        people: { [id(90)]: 'Grace Hopper' },
      },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as {
      operations: { body: (typeof posted)[number] }[];
    };
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toContainText('5 items');

  // Every object laid out and drawn, nothing stale.
  for (const i of [FLOW, OVERVIEW, PAY_NOTES, BUILD, WEBHOOK]) {
    await page.waitForFunction(
      (x) =>
        (
          window as unknown as {
            Konva: { stages: { findOne(s: string): { className: string } | undefined }[] };
          }
        ).Konva.stages[0]?.findOne(`#${x}`)?.className === 'Image',
      i,
      { timeout: 60_000 },
    );
    expect(await hook(page, (h, x) => h.layout(x)?.stale, i)).toBe(false);
  }
  expect(
    Object.keys((await hook(page, (h, x) => h.layout(x)?.elements, FLOW)) ?? {}).sort(),
  ).toEqual(['API', 'Client', 'Orders', 'Pay', 'Provider']);

  // Four links, every anchor found in its diagram.
  await expect.poll(async () => (await hook(page, (h) => h.links())).length).toBe(4);
  expect((await hook(page, (h) => h.links())).filter((l) => l.broken)).toEqual([]);

  // Work from it: start the next task, through the same path a click takes.
  await page.evaluate(() =>
    (window as unknown as { __objects: { apply(...b: unknown[]): void } }).__objects.apply({
      type: 'task.set',
      itemId: '01a01640-6b72-7d60-968b-88be186f9004',
      taskId: 't3',
      state: 'doing',
    }),
  );
  await expect.poll(() => posted.filter((op) => op.type === 'task.set').length).toBe(1);
  expect(posted.find((op) => op.type === 'task.set')).toMatchObject({
    itemId: BUILD,
    taskId: 't3',
    state: 'doing',
  });
  expect(await hook(page, (h, x) => h.item(x)?.content.tasks?.map((t) => t.state), BUILD)).toEqual([
    'done',
    'doing',
    'doing',
  ]);
});
