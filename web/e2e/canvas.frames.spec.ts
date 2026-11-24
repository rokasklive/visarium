import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Framed groups take items in and out on drop (canvas/group-frames), from the
 * browser's side: the drop goes out as one batch with the move, the frame is
 * redrawn around the new member, and a reload shows the same membership. The
 * rule itself is unit-tested in canvas-core's `frames.test.ts`.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f7d00';
const A = '01a01640-6b72-7d60-968b-88be186f7d01';
const B = '01a01640-6b72-7d60-968b-88be186f7d02';
const LOOSE = '01a01640-6b72-7d60-968b-88be186f7d03';
const GROUP = '01a01640-6b72-7d60-968b-88be186f7d10';

interface Op {
  readonly type: string;
  readonly itemId?: string;
  readonly groupId?: string;
  readonly memberIds?: string[];
  readonly transform?: Record<string, number>;
}

const note = (id: string, x: number, y: number, groupId?: string) => ({
  id,
  transform: { x, y, width: 300, height: 120, rotation: 0 },
  z: 1,
  revision: 0,
  content: { kind: 'note', source: 'A note' },
  ...(groupId ? { groupId } : {}),
});

/** A board that applies what it is sent, so a reload shows the result. */
async function stubBoard(page: Page) {
  const posted: Op[][] = [];
  const items = new Map(
    [note(A, -350, -100, GROUP), note(B, 350, -100, GROUP), note(LOOSE, 0, 150)].map((i) => [
      i.id,
      i as Record<string, unknown>,
    ]),
  );
  const group = { id: GROUP, memberIds: [A, B], frame: true };
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      json: { revision: posted.length, items: [...items.values()], groups: [group], links: [] },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Op }[] };
    const batch = body.operations.map((o) => o.body);
    posted.push(batch);
    for (const op of batch) {
      const item = op.itemId ? items.get(op.itemId) : undefined;
      if (op.type === 'item.transform' && item) item.transform = op.transform;
      if (op.type === 'group.members' && op.memberIds) {
        for (const it of items.values()) if (it.groupId === GROUP) delete it.groupId;
        for (const id of op.memberIds) {
          const it = items.get(id);
          if (it) it.groupId = GROUP;
        }
        group.memberIds = op.memberIds;
      }
    }
    await route.fulfill({ json: { revision: posted.length, operations: batch } });
  });
  return posted;
}

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toContainText('3 items');
  // The stage mounts its canvases a moment after the stats, and may remount.
  await expect.poll(() => page.locator('canvas').first().boundingBox()).not.toBeNull();
}

/**
 * Where to press a note, in screen pixels: on its text, which is what a note is
 * hit on. Read from the drawn node once it holds still, since a note settles to
 * its rendered height after load and its text moves with it.
 */
async function grip(page: Page, id: string) {
  const read = () =>
    page.evaluate((i) => {
      const w = window as unknown as {
        Konva: {
          stages: {
            findOne(s: string): { getClientRect(): { x: number; y: number; height: number } };
          }[];
        };
      };
      return w.Konva.stages[0]?.findOne(`#${i}`).getClientRect() ?? null;
    }, id);
  let r = await read();
  await expect
    .poll(async () => {
      const previous = r;
      r = await read();
      return JSON.stringify(r) === JSON.stringify(previous);
    })
    .toBe(true);
  const canvas = await page.locator('canvas').first().boundingBox();
  if (!canvas || !r) throw new Error(`no node for ${id}`);
  // 60 in, clear of the left-middle resize handle a picked note shows.
  return { x: canvas.x + r.x + 60, y: canvas.y + r.y + r.height / 2 };
}

/** The item's group, `null` when loose, `'loading'` before the board is up. */
const groupOf = (page: Page, id: string) =>
  page.evaluate((i) => {
    const objects = (
      window as unknown as { __objects?: { item(id: string): { groupId?: string } | undefined } }
    ).__objects;
    const item = objects?.item(i);
    return item ? (item.groupId ?? null) : 'loading';
  }, id);

/** The drawn frame's horizontal extent (world units) and stroke, or null while not drawn. */
const frameBounds = (page: Page) =>
  page.evaluate((g) => {
    const w = window as unknown as {
      Konva: {
        stages: {
          findOne(s: string): { points(): number[]; stroke(): string } | undefined;
        }[];
      };
    };
    const node = w.Konva.stages.map((stage) => stage.findOne(`#gframe-${g}`)).find(Boolean);
    if (!node) return null;
    const xs = node.points().filter((_, i) => i % 2 === 0);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), stroke: node.stroke() };
  }, GROUP);

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a note dropped into a frame joins it, and one held out of it leaves', async ({ page }) => {
  const posted = await stubBoard(page);
  await openBoard(page);

  // Everything stays well inside the view: a drag that leaves the canvas is not
  // a drop. LOOSE (centre 0, 150) is dropped with its centre between A and B,
  // inside the frame, clear of both so the next press finds B and nothing else.
  const g = await grip(page, LOOSE);
  await drag(page, g, { x: g.x, y: g.y - 250 });
  await expect.poll(() => groupOf(page, LOOSE)).toBe(GROUP);
  // Move and membership went out together.
  const joined = () => posted.find((b) => b.some((op) => op.type === 'group.members'));
  await expect
    .poll(() =>
      joined()
        ?.map((op) => op.type)
        .sort(),
    )
    .toEqual(['group.members', 'item.transform']);
  // The frame encloses the new member.
  await expect
    .poll(async () => {
      const f = await frameBounds(page);
      return f !== null && f.minX <= -150 && f.maxX >= 150;
    })
    .toBe(true);

  await openBoard(page);
  await expect.poll(() => groupOf(page, LOOSE)).toBe(GROUP);
  // A click on the new member selects its whole group. Retried: straight after
  // load the hit canvas may not be drawn yet, and a click then lands on nothing.
  const l = await grip(page, LOOSE);
  await expect(async () => {
    await page.mouse.click(l.x, l.y);
    await expect(page.getByTestId('canvas-stats')).toContainText('3 selected', { timeout: 500 });
  }).toPass();

  // Hold on B to pick it out of its group, then drag it below the frame.
  const b = await grip(page, B);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.move(b.x, b.y + 250, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => groupOf(page, B)).toBeNull();
  expect(await groupOf(page, A)).toBe(GROUP);

  await expect
    .poll(() => posted.filter((b) => b.some((op) => op.type === 'group.members')).length)
    .toBe(2);
  await openBoard(page);
  await expect.poll(() => groupOf(page, B)).toBeNull();
  await expect.poll(() => groupOf(page, LOOSE)).toBe(GROUP);
});

test('the drag shows which frame it would join or leave', async ({ page }) => {
  await stubBoard(page);
  await openBoard(page);
  await expect.poll(() => frameBounds(page)).not.toBeNull();
  const before = await frameBounds(page);
  if (!before) throw new Error('no frame');
  const shots = process.env.FRAMES_SHOTS;

  // Over the frame: it is highlighted. Back out: it is not.
  const g = await grip(page, LOOSE);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x, g.y - 250, { steps: 12 });
  await expect.poll(async () => (await frameBounds(page))?.stroke).not.toBe(before.stroke);
  if (shots) await page.screenshot({ path: `${shots}/join.png` });
  await page.mouse.move(g.x, g.y, { steps: 12 });
  await expect.poll(async () => (await frameBounds(page))?.stroke).toBe(before.stroke);
  await page.mouse.up();
  expect(await groupOf(page, LOOSE)).toBeNull();

  // A member held out of the frame: drawn around the rest. Back in: around it again.
  const b = await grip(page, B);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.move(b.x, b.y + 250, { steps: 12 });
  await expect.poll(async () => (await frameBounds(page))?.maxX).toBeLessThan(0);
  if (shots) await page.screenshot({ path: `${shots}/leave.png` });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await expect.poll(async () => (await frameBounds(page))?.maxX).toBe(before.maxX);
  await page.mouse.up();
  expect(await groupOf(page, B)).toBe(GROUP);
  expect(await frameBounds(page)).toEqual(before);
});
