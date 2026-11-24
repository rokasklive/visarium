import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { canvasBox, signedIn } from './session';

/**
 * A board that outlives the tab, from the browser's side.
 *
 * The API is stubbed rather than run, for the same reason the capture spec
 * stubs it: what has no unit-test equivalent here is the browser half — that an
 * item loaded from a snapshot is really on the board, that a drag really posts
 * an operation, and that a freshly dropped image is not sent until its upload
 * resolves. The server half is BoardIT and BoardOperationsIT, which run against
 * real PostgreSQL.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f32db';
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f32dc';

interface Posted {
  readonly type: string;
  readonly itemId?: string;
  readonly groupId?: string;
  readonly memberIds?: string[];
  readonly z?: number;
  readonly transform?: { x: number; y: number };
  readonly content?: { kind: string; asset?: { assetId: string } };
}

/**
 * A board that remembers, so a reload has something to reload.
 *
 * This is a test double and only as clever as the tests need: it applies the
 * operations the client posts so the next snapshot reflects them. What it proves
 * is the CLIENT half of the round trip — that what is sent is what comes back
 * and is drawn. The server's own applier is proven against real PostgreSQL by
 * BoardOperationsIT and BoardSurvivesRestartIT.
 */
class StubBoard {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly groups = new Map<string, Record<string, unknown>>();

  apply(body: Posted) {
    const item = body.itemId ? this.items.get(body.itemId) : undefined;
    switch (body.type) {
      case 'item.create':
        this.items.set(body.itemId as string, {
          id: body.itemId,
          transform: body.transform,
          z: body.z,
          content: body.content,
        });
        break;
      case 'item.delete':
        this.items.delete(body.itemId as string);
        break;
      case 'item.transform':
        if (item) item.transform = body.transform;
        break;
      case 'item.z':
        if (item) item.z = body.z;
        break;
      case 'group.create':
        this.groups.set(body.groupId as string, {
          id: body.groupId,
          memberIds: body.memberIds ?? [],
        });
        for (const id of body.memberIds ?? []) {
          const member = this.items.get(id);
          if (member) member.groupId = body.groupId;
        }
        break;
      default:
        break;
    }
  }

  snapshot() {
    return {
      revision: this.items.size,
      items: [...this.items.values()].sort((a, b) => Number(a.z) - Number(b.z)),
      groups: [...this.groups.values()],
    };
  }
}

function snapshotItem(id: string, x: number, z: number) {
  return {
    id,
    transform: { x, y: 0, width: 300, height: 225, rotation: 0 },
    z,
    content: {
      kind: 'image',
      asset: { assetId: ASSET_ID, intrinsicWidth: 1600, intrinsicHeight: 1200 },
    },
  };
}

/** A board on the wire, plus everything the client posts back to it. */
async function stubBoardApi(
  page: Page,
  options: { items?: Record<string, unknown>[]; failSnapshot?: boolean } = {},
) {
  const posted: Posted[] = [];
  const board = new StubBoard();
  for (const item of options.items ?? []) board.items.set(item.id as string, { ...item });
  const bytes = readFileSync(FIXTURE);

  await page.route(`**/api/boards/${BOARD}/snapshot`, async (route) => {
    if (options.failSnapshot) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(board.snapshot()),
    });
  });

  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Posted }[] };
    for (const operation of body.operations) {
      posted.push(operation.body);
      board.apply(operation.body);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: 5 }),
    });
  });

  await page.route('**/api/assets', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: ASSET_ID, width: 512, height: 512, byteSize: bytes.length }),
    }),
  );
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );

  return posted;
}

async function stats(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return { selected: Number(/(\d+) selected/.exec(text)?.[1] ?? 0) };
}

async function itemCount(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
}

async function openBoard(page: Page, id = BOARD) {
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await canvasBox(page);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real drop: a DataTransfer built in the page, carrying real bytes. */
async function dropImage(page: Page, at: { x: number; y: number }) {
  const bytes = [...readFileSync(FIXTURE)];
  const transfer = await page.evaluateHandle(async (data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' }));
    return dt;
  }, bytes);

  await page.dispatchEvent('canvas', 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'drop', {
    dataTransfer: transfer,
    clientX: at.x,
    clientY: at.y,
  });
}

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('a persisted board opens with what was on it', async ({ page }) => {
  await stubBoardApi(page, {
    items: [
      snapshotItem('01a01640-6b72-7d60-968b-88be186f3201', 0, 1),
      snapshotItem('01a01640-6b72-7d60-968b-88be186f3202', 400, 2),
    ],
  });

  await openBoard(page);

  await expect.poll(() => itemCount(page)).toBe(2);
});

test('a board that fails to load says so instead of looking empty', async ({ page }) => {
  await stubBoardApi(page, { failSnapshot: true });

  await page.goto(`/boards/${BOARD}`);

  await expect(page.getByText('could not be loaded')).toBeVisible();
  // The distinction that matters: no canvas at all, rather than an empty one
  // inviting the user to rebuild work that already exists.
  await expect(page.getByTestId('canvas-stats')).toBeHidden();
});

test('a generated board never talks to the server about boards', async ({ page }) => {
  const boardRequests: string[] = [];
  page.on('request', (request) => {
    // The pathname, not the URL: Vite serves the module `/src/api/boards.ts`,
    // which contains the API path as a substring.
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/boards')) boardRequests.push(pathname);
  });

  await openBoard(page, 'small');
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(460, 340, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(boardRequests).toEqual([]);
});

test('a drag on a persisted board is posted as an operation', async ({ page }) => {
  const item = '01a01640-6b72-7d60-968b-88be186f3201';
  const posted = await stubBoardApi(page, { items: [snapshotItem(item, 0, 1)] });
  const centre = await openBoard(page);

  // The item sits at world origin, which the default camera puts at the centre.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 60, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => posted.filter((body) => body.type === 'item.transform')).not.toEqual([]);
  const moved = posted.find((body) => body.type === 'item.transform');
  expect(moved?.itemId).toBe(item);
  expect(moved?.transform?.x).toBeGreaterThan(0);

  // No save button, anywhere. North star 3.
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
});

test('a dropped image is persisted only once its upload resolves', async ({ page }) => {
  const posted = await stubBoardApi(page, { items: [] });
  const centre = await openBoard(page);

  await dropImage(page, centre);
  await expect.poll(() => itemCount(page)).toBe(1);

  // One creation, carrying the asset — never a placeholder, which the schema
  // cannot hold.
  await expect.poll(() => posted.filter((body) => body.type === 'item.create').length).toBe(1);
  const created = posted.find((body) => body.type === 'item.create');
  expect(created?.content?.kind).toBe('image');
  expect(created?.content?.asset?.assetId).toBe(ASSET_ID);
  expect(posted.every((body) => body.content?.kind !== 'placeholder')).toBe(true);
});

test('an image dropped and undone before its upload lands is never persisted', async ({ page }) => {
  let release: (() => void) | undefined;
  const posted = await stubBoardApi(page, { items: [] });
  await page.route('**/api/assets', async (route) => {
    await new Promise<void>((resume) => {
      release = resume;
    });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: ASSET_ID, width: 512, height: 512, byteSize: 1 }),
    });
  });

  const centre = await openBoard(page);
  await dropImage(page, centre);
  await expect.poll(() => itemCount(page)).toBe(1);

  await page.keyboard.press('Control+z');
  await expect.poll(() => itemCount(page)).toBe(0);

  await expect.poll(() => Boolean(release)).toBe(true);
  release?.();
  await page.waitForTimeout(800);

  // The asset was stored and stays stored — assets outlive boards — but this
  // board never heard of the item, so nothing about it was ever sent.
  expect(posted).toEqual([]);
});

test('a dropped image is still there after a reload', async ({ page }) => {
  const posted = await stubBoardApi(page, { items: [] });
  const centre = await openBoard(page);

  await dropImage(page, centre);
  await expect.poll(() => posted.filter((body) => body.type === 'item.create').length).toBe(1);

  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toBeVisible();

  // Not just a count: clicking where it was dropped selects it, so it is really
  // there, at that position, drawn from the asset it resolved to.
  await expect.poll(() => itemCount(page)).toBe(1);
  // The move before the click is not decoration: the pointer is left where the
  // drop put it, and a click with no preceding move gives the canvas no pointer
  // position to hit-test. A real pointer always moves.
  await page.mouse.move(centre.x - 300, centre.y - 300);
  await page.mouse.click(centre.x, centre.y);
  await expect.poll(async () => (await stats(page)).selected).toBe(1);
});

test('an arrangement survives a reload, with no save anywhere in the flow', async ({ page }) => {
  const first = '01a01640-6b72-7d60-968b-88be186f3201';
  const second = '01a01640-6b72-7d60-968b-88be186f3202';
  const posted = await stubBoardApi(page, {
    items: [snapshotItem(first, 0, 1), snapshotItem(second, 500, 2)],
  });
  const centre = await openBoard(page);
  const box = await canvasBox(page);

  // Drag the first item, then group both, then send them to the back.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x - 220, centre.y + 140, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => posted.some((body) => body.type === 'item.transform')).toBe(true);

  // Marquee both: there is no select-all binding, and inventing one for a test
  // would be the test changing the product.
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await stats(page)).selected).toBe(2);

  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(() => posted.some((body) => body.type === 'group.create')).toBe(true);
  await expect.poll(() => posted.some((body) => body.type === 'item.z')).toBe(true);

  // At no point was anything saved: there is no such control.
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await expect.poll(() => itemCount(page)).toBe(2);

  // The dragged item is where it was left, and it is still grouped with the
  // other one — so one click on it selects both.
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.click(centre.x - 220, centre.y + 140);
  await expect.poll(async () => (await stats(page)).selected).toBe(2);
});
