import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Making and changing objects by hand (canvas/notes, canvas/diagrams,
 * canvas/checklists): double-click, paste, drop, the controls inside an
 * object, and the in-place editors. Every assertion is on what goes to the
 * server, because that is what the next viewer and the next agent see.
 *
 * The camera starts with world origin at the canvas centre at zoom 1, so a
 * world point is the canvas centre plus that point.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f6000';
const NOTE = '01a01640-6b72-7d60-968b-88be186f6001';
const LIST = '01a01640-6b72-7d60-968b-88be186f6002';
const GRACE = '01a01640-6b72-7d60-968b-88be186f6003';
const OTHER_ACTOR = '01a01640-6b72-7d60-968b-88be186f6099';

interface Op {
  type: string;
  itemId?: string;
  [k: string]: unknown;
}

const note = (source: string) => ({
  id: NOTE,
  transform: { x: 0, y: 0, width: 320, height: 120, rotation: 0 },
  z: 1,
  revision: 0,
  content: { kind: 'note', source },
});

const checklist = () => ({
  id: LIST,
  transform: { x: 0, y: 0, width: 320, height: 120, rotation: 0 },
  z: 1,
  revision: 0,
  content: {
    kind: 'checklist',
    title: 'Build',
    tasks: [
      { id: 't1', text: 'Interface', state: 'done', by: GRACE, at: '2026-11-18T09:12:00Z' },
      { id: 't2', text: 'Keys', state: 'todo' },
    ],
  },
});

async function stubBoard(page: Page, items: unknown[]) {
  const posted: Op[] = [];
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: { revision: 1, items, groups: [], links: [], people: { [GRACE]: 'Grace Hopper' } },
    }),
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

async function open(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

type Rect = { x: number; y: number; width: number; height: number };
type Hit = { kind: string; index?: number; taskId?: string; rect: Rect };

/** Until the object is on screen as a bitmap, as it is before a person can aim at it. */
async function drawn(page: Page, itemId: string) {
  await page.waitForFunction(
    (i) =>
      (
        window as unknown as {
          Konva: { stages: { findOne(s: string): { className: string } | undefined }[] };
        }
      ).Konva.stages[0]?.findOne(`#${i}`)?.className === 'Image',
    itemId,
  );
  // One more frame, so the hit canvas has caught up with the drawing.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/** The screen centre of an object's control, from its laid-out hit region. */
async function controlCentre(
  page: Page,
  centre: { x: number; y: number },
  itemId: string,
  match: (h: Hit) => boolean,
) {
  const layout = (await (
    await page.waitForFunction(
      (i) =>
        (window as unknown as { __objects?: { layout(id: string): unknown } }).__objects?.layout(i),
      itemId,
    )
  ).jsonValue()) as { hits: Hit[] };
  const hit = layout.hits.find(match);
  if (!hit) throw new Error('no such control');
  await drawn(page, itemId);
  // The test items sit at world (0, 0), 320 wide, stored 120 high: their top-left is (-160, -60).
  return {
    x: centre.x - 160 + hit.rect.x + hit.rect.width / 2,
    y: centre.y - 60 + hit.rect.y + hit.rect.height / 2,
  };
}

const ofType = (posted: Op[], type: string) => posted.filter((op) => op.type === type);

async function paste(page: Page, text: string) {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, text);
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('double-clicking empty board starts a note there; leaving it empty makes nothing', async ({
  page,
}) => {
  const posted = await stubBoard(page, []);
  const centre = await open(page);

  await page.mouse.dblclick(centre.x + 100, centre.y + 50);
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'New note' })).toHaveCount(0);

  await page.mouse.dblclick(centre.x + 100, centre.y + 50);
  await page.keyboard.type('Hello **board**');
  await page.keyboard.press('Escape');
  await expect.poll(() => ofType(posted, 'item.create').length).toBe(1);
  const created = ofType(posted, 'item.create')[0] as Op & {
    content: unknown;
    transform: { x: number; y: number; height: number };
  };
  expect(created.content).toEqual({ kind: 'note', source: 'Hello **board**' });
  expect(created.transform.x).toBeCloseTo(100, 0);
  expect(
    created.transform.y - created.transform.height / 2,
    'its top edge is where the click was',
  ).toBeCloseTo(50, 0);
});

test('pasted text becomes a note, a diagram or a checklist, under the pointer', async ({
  page,
}) => {
  const posted = await stubBoard(page, []);
  const centre = await open(page);
  await page.mouse.move(centre.x - 200, centre.y + 30);

  await paste(page, 'Some prose about the checkout.');
  await paste(page, 'flowchart LR\n  API --> Pay');
  await paste(page, '@startuml\nA -> B\n@enduml');
  await paste(page, '## Release\n- [ ] Tag\n- [x] Changelog');
  await expect.poll(() => ofType(posted, 'item.create').length).toBe(4);
  const contents = ofType(posted, 'item.create').map(
    (op) => op.content as { kind: string; lang?: string; title?: string },
  );
  expect(contents.map((c) => c.lang ?? c.kind)).toEqual([
    'note',
    'mermaid',
    'plantuml',
    'checklist',
  ]);
  expect(contents[3]?.title).toBe('Release');
  const first = ofType(posted, 'item.create')[0] as Op & { transform: { x: number } };
  expect(first.transform.x).toBeCloseTo(-200, 0);
});

test('dropped .mmd and .puml files become diagrams, a .md checklist a checklist', async ({
  page,
}) => {
  const posted = await stubBoard(page, []);
  const centre = await open(page);
  await page.evaluate(
    ([x, y]) => {
      const data = new DataTransfer();
      data.items.add(new File(['graph TD\n  A --> B'], 'flow.mmd'));
      data.items.add(new File(['@startuml\nA -> B\n@enduml'], 'webhook.puml'));
      data.items.add(new File(['- [ ] one\n- [ ] two'], 'todo.md'));
      document.querySelector('canvas')?.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [centre.x, centre.y] as const,
  );
  await expect.poll(() => ofType(posted, 'item.create').length).toBe(3);
  const kinds = ofType(posted, 'item.create').map((op) => {
    const c = op.content as { kind: string; lang?: string };
    return c.lang ?? c.kind;
  });
  expect(kinds).toEqual(['mermaid', 'plantuml', 'checklist']);
});

test('a note is edited in place, saved as it is typed, and undone in one step', async ({
  page,
}) => {
  const posted = await stubBoard(page, [note('### Overview\n\nFirst draft.')]);
  const centre = await open(page);
  await drawn(page, NOTE);

  await page.mouse.dblclick(centre.x, centre.y - 40);
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toHaveValue('### Overview\n\nFirst draft.');
  await editor.press('ControlOrMeta+a');
  await page.keyboard.type('### Overview\n\nSecond draft.');
  await expect
    .poll(() => ofType(posted, 'item.source').length, { timeout: 5000 })
    .toBeGreaterThan(0);
  expect(ofType(posted, 'item.source')[0]).toMatchObject({ itemId: NOTE, baseRevision: 0 });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  const saves = ofType(posted, 'item.source').length;
  expect(ofType(posted, 'item.source').at(-1)?.source).toBe('### Overview\n\nSecond draft.');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => ofType(posted, 'item.source').length).toBe(saves + 1);
  expect(ofType(posted, 'item.source').at(-1)).toMatchObject({
    source: '### Overview\n\nFirst draft.',
  });
  expect(
    ofType(posted, 'item.source').at(-1)?.baseRevision,
    'undo is deliberate, never refused as stale',
  ).toBeUndefined();
});

test('ticking a checkbox in a note changes that line of its source and nothing else', async ({
  page,
}) => {
  const source = '### Shot list\n\n- [ ] Hero\n- [ ] Palette';
  const posted = await stubBoard(page, [note(source)]);
  const centre = await open(page);
  const box = await controlCentre(
    page,
    centre,
    NOTE,
    (h) => h.kind === 'checkbox' && h.index === 1,
  );
  await page.mouse.click(box.x, box.y);
  await expect.poll(() => ofType(posted, 'item.source').length).toBe(1);
  expect(ofType(posted, 'item.source')[0]?.source).toBe(
    '### Shot list\n\n- [ ] Hero\n- [x] Palette',
  );
  // The only transform is the note's new height, written by its author, with the
  // top edge where it was: a click on a control never moves the note.
  await page.waitForTimeout(500);
  for (const op of ofType(posted, 'item.transform')) {
    const t = op.transform as { x: number; y: number; height: number };
    expect(t.x).toBe(0);
    expect(t.y - t.height / 2).toBeCloseTo(-60, 6);
  }
});

test('a checklist moves tasks on with clicks and is typed into line by line', async ({ page }) => {
  const posted = await stubBoard(page, [checklist()]);
  const centre = await open(page);
  const marker = await controlCentre(
    page,
    centre,
    LIST,
    (h) => h.kind === 'task-state' && h.taskId === 't2',
  );

  await page.mouse.click(marker.x, marker.y);
  await expect.poll(() => ofType(posted, 'task.set').length).toBe(1);
  expect(ofType(posted, 'task.set')[0]).toMatchObject({ taskId: 't2', state: 'doing' });
  await page.keyboard.down('Shift');
  await page.mouse.click(marker.x, marker.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => ofType(posted, 'task.set').length).toBe(2);
  expect(ofType(posted, 'task.set')[1]).toMatchObject({ taskId: 't2', state: 'blocked' });

  // Click a task's text, retype it, Enter for a new task after it, Enter again to stop.
  const text = await controlCentre(
    page,
    centre,
    LIST,
    (h) => h.kind === 'task-text' && h.taskId === 't1',
  );
  await page.mouse.click(text.x, text.y);
  const field = page.getByRole('textbox', { name: 'Task' });
  await expect(field).toHaveValue('Interface');
  await field.press('ControlOrMeta+a');
  await page.keyboard.type('Interface agreed');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'New task' })).toBeFocused();
  await page.keyboard.type('Between');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'New task' })).toHaveCount(0);
  await expect.poll(() => ofType(posted, 'task.add').length).toBe(1);
  expect(ofType(posted, 'task.set').at(-1)).toMatchObject({
    taskId: 't1',
    text: 'Interface agreed',
  });
  expect(ofType(posted, 'task.add')[0]).toMatchObject({
    index: 1,
    task: { id: 't3', text: 'Between', state: 'todo' },
  });

  // Emptying a task and pressing Backspace once more removes it.
  const again = await controlCentre(
    page,
    centre,
    LIST,
    (h) => h.kind === 'task-text' && h.taskId === 't3',
  );
  await page.mouse.click(again.x, again.y);
  await page.getByRole('textbox', { name: 'Task' }).press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect.poll(() => ofType(posted, 'task.remove').length).toBe(1);
  expect(ofType(posted, 'task.remove')[0]).toMatchObject({ taskId: 't3' });
});

test('hovering a task says who last changed it', async ({ page }) => {
  await stubBoard(page, [checklist()]);
  const centre = await open(page);
  const text = await controlCentre(
    page,
    centre,
    LIST,
    (h) => h.kind === 'task-text' && h.taskId === 't1',
  );
  await expect(page.getByTestId('object-tip')).toHaveCount(0);
  await page.mouse.move(text.x, text.y);
  await expect(page.getByTestId('object-tip')).toContainText('Grace Hopper');
  await page.mouse.move(centre.x + 400, centre.y + 250);
  await expect(page.getByTestId('object-tip')).toHaveCount(0);
});

test('a note someone else is editing does not open for a second person', async ({ page }) => {
  await page.addInitScript((socketPath) => {
    const control = { deliver: (_: unknown) => {}, opened: false };
    (window as unknown as { __socket: typeof control }).__socket = control;
    const Real = window.WebSocket;
    class Stub extends EventTarget {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(public url: string) {
        super();
        queueMicrotask(() => {
          control.opened = true;
          control.deliver = (f) => this.onmessage?.({ data: JSON.stringify(f) });
          this.onopen?.();
        });
      }
      send() {}
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = new Proxy(Real, {
      construct: (t, a: [string]) =>
        a[0].includes(socketPath)
          ? (new Stub(a[0]) as unknown as WebSocket)
          : Reflect.construct(t, a),
    });
  }, '/ws/canvas/');
  await stubBoard(page, [note('### Overview')]);
  const centre = await open(page);
  await page.waitForFunction(
    () => (window as unknown as { __socket: { opened: boolean } }).__socket.opened,
  );
  await page.evaluate(
    ([item, other]) => {
      const s = (window as unknown as { __socket: { deliver(f: unknown): void } }).__socket;
      s.deliver({
        t: 'welcome',
        actorId: '01a01640-6b72-7d60-968b-88be186f6098',
        revision: 1,
        actors: [],
      });
      s.deliver({ t: 'lock', itemIds: [item], heldBy: other, expiresAt: Date.now() + 60_000 });
    },
    [NOTE, OTHER_ACTOR] as const,
  );
  await drawn(page, NOTE);
  await page.mouse.dblclick(centre.x, centre.y - 40);
  await page.waitForTimeout(300);
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveCount(0);
});

test('typing diagram source into a new note makes a diagram', async ({ page }) => {
  const posted = await stubBoard(page, []);
  const centre = await open(page);
  await page.mouse.dblclick(centre.x + 100, centre.y + 50);
  await page.keyboard.type('flowchart LR\n  API --> Pay[Payment adapter]');
  await page.keyboard.press('Escape');
  await expect.poll(() => ofType(posted, 'item.create').length).toBe(1);
  expect(ofType(posted, 'item.create')[0]?.content).toEqual({
    kind: 'diagram',
    lang: 'mermaid',
    source: 'flowchart LR\n  API --> Pay[Payment adapter]',
  });
});

test('a note edited into diagram source becomes that diagram, keeping its id and links', async ({
  page,
}) => {
  const OTHER = '01a01640-6b72-7d60-968b-88be186f6010';
  const LINK = '01a01640-6b72-7d60-968b-88be186f6011';
  const posted: Op[] = [];
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          note('Draft'),
          {
            ...note('Explains it'),
            id: OTHER,
            transform: { x: 0, y: 200, width: 320, height: 120, rotation: 0 },
          },
        ],
        groups: [],
        links: [
          {
            id: LINK,
            from: { itemId: OTHER, element: null },
            to: { itemId: NOTE, element: null },
            linkType: 'describes',
          },
        ],
        people: {},
      },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    for (const { body: op } of body.operations) posted.push(op);
    await route.fulfill({
      json: { revision: 1 + posted.length, operations: body.operations.map((o) => o.body) },
    });
  });
  const centre = await open(page);
  await drawn(page, NOTE);
  await page.mouse.dblclick(centre.x, centre.y - 50);
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeVisible();
  // No resize frame while the editor is the object's frame.
  const framed = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            Konva: { stages: { findOne(s: string): { nodes(): unknown[] } | undefined }[] };
          }
        ).Konva.stages[0]
          ?.findOne('Transformer')
          ?.nodes().length ?? 0,
    );
  expect(await framed()).toBe(0);
  await editor.press('ControlOrMeta+a');
  await page.keyboard.type('flowchart LR\n  API --> Pay');
  await page.keyboard.press('Escape');

  await expect.poll(() => ofType(posted, 'item.create').length).toBe(1);
  expect(ofType(posted, 'item.create')[0]).toMatchObject({
    itemId: NOTE,
    content: { kind: 'diagram', lang: 'mermaid' },
  });
  expect(ofType(posted, 'link.add')[0]).toMatchObject({ linkId: LINK, to: { itemId: NOTE } });
  await expect.poll(framed, 'the frame is back once editing ends').toBe(1);

  // One undo takes the conversion back: the note, with its link.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => ofType(posted, 'item.create').length).toBe(2);
  expect(ofType(posted, 'item.create')[1]).toMatchObject({
    itemId: NOTE,
    content: { kind: 'note' },
  });
  expect(ofType(posted, 'link.add')).toHaveLength(2);
});
