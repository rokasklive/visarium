import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { SIGNED_IN_USER } from './session';

/**
 * M07's exit criterion, as one walk.
 *
 * Not a feature list: a reference board built, organised, revisited and cleaned
 * up entirely through the interface, without hitting an architectural seam. What
 * "seam" means concretely, and what this spec is watching for — no reload to see
 * a change, no dialog that should not exist, no act that says one thing and does
 * another.
 *
 * The server is a test double rather than a stub per call, because the walk's
 * whole point is that state carries from one act to the next: an image dropped
 * in step 2 is the one renamed in step 7 and cascaded in step 9. The SERVER half
 * of every one of these acts is proven against real PostgreSQL by
 * `AssetLifecycleIT`, `BoardIT` and `LibraryIT`; what only a browser can prove is
 * that the acts join up.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');

interface StubAsset {
  id: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  deletedAt: string | null;
}

interface StubItem {
  id: string;
  transform: unknown;
  z: number;
  groupId?: string | null;
  content: { kind: string; asset?: { assetId: string } };
}

interface StubBoard {
  id: string;
  title: string;
  revision: number;
  items: Map<string, StubItem>;
  groups: Map<string, { id: string; memberIds: string[] }>;
}

/**
 * The instance, in memory.
 *
 * It enforces the rules the walk depends on and nothing more: content is unique
 * by nothing here (every upload is a new asset, which is what the walk does),
 * deleting is refused while an item references the asset, a cascade removes the
 * items through the same operation shape a client would post, and purging
 * removes the row.
 */
class Instance {
  readonly boards = new Map<string, StubBoard>();
  readonly assets = new Map<string, StubAsset>();
  readonly collections = new Map<string, { id: string; name: string }>();
  readonly members = new Map<string, Set<string>>();
  private next = 0;

  id(): string {
    this.next += 1;
    return `01a01640-6b72-7d60-968b-${String(this.next).padStart(12, '0')}`;
  }

  board(id: string): StubBoard | undefined {
    return this.boards.get(id);
  }

  createBoard(title: string): StubBoard {
    const board: StubBoard = {
      id: this.id(),
      title,
      revision: 0,
      items: new Map(),
      groups: new Map(),
    };
    this.boards.set(board.id, board);
    return board;
  }

  /** Item ids and group ids are re-minted, exactly as the server's statement does. */
  duplicate(source: StubBoard): StubBoard {
    const copy = this.createBoard(`${source.title} copy`);
    const groupMap = new Map<string, string>();
    for (const group of source.groups.values()) {
      const id = this.id();
      groupMap.set(group.id, id);
      copy.groups.set(id, { id, memberIds: [] });
    }
    for (const item of source.items.values()) {
      const id = this.id();
      const groupId = item.groupId ? groupMap.get(item.groupId) : undefined;
      copy.items.set(id, { ...item, id, ...(groupId ? { groupId } : {}) });
      if (groupId) copy.groups.get(groupId)?.memberIds.push(id);
    }
    return copy;
  }

  apply(board: StubBoard, body: Record<string, unknown>) {
    const itemId = body.itemId as string;
    const item = itemId ? board.items.get(itemId) : undefined;
    switch (body.type) {
      case 'item.create':
        board.items.set(itemId, {
          id: itemId,
          transform: body.transform,
          z: body.z as number,
          content: body.content as StubItem['content'],
        });
        break;
      case 'item.delete':
        board.items.delete(itemId);
        break;
      case 'item.transform':
        if (item) item.transform = body.transform;
        break;
      case 'item.content':
        if (item) item.content = body.content as StubItem['content'];
        break;
      case 'item.z':
        if (item) item.z = body.z as number;
        break;
      case 'group.create': {
        const groupId = body.groupId as string;
        board.groups.set(groupId, { id: groupId, memberIds: (body.memberIds as string[]) ?? [] });
        for (const id of (body.memberIds as string[]) ?? []) {
          const member = board.items.get(id);
          if (member) member.groupId = groupId;
        }
        break;
      }
      default:
        break;
    }
    board.revision += 1;
  }

  /** Which boards still show an asset, and with how many items. */
  usage(assetId: string) {
    return [...this.boards.values()]
      .map((board) => ({
        id: board.id,
        title: board.title,
        items: [...board.items.values()].filter((i) => i.content.asset?.assetId === assetId).length,
      }))
      .filter((entry) => entry.items > 0);
  }
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * One dispatcher rather than fifteen routes.
 *
 * Playwright matches the most recently registered route first, and a walk that
 * touches every endpoint is exactly where a mis-ordered glob silently shadows
 * the route that mattered.
 *
 * Matched on the PATHNAME rather than with a glob. `**\/api/**` also matches
 * `/src/api/assets.ts`, which is how Vite serves this application's own source
 * in development — the page then receives JSON where it asked for a module and
 * renders nothing at all.
 */
async function instance(page: Page): Promise<Instance> {
  const bytes = readFileSync(FIXTURE);
  const world = new Instance();

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const body = () => (request.postDataJSON() ?? {}) as Record<string, unknown>;

      if (path === '/api/session') {
        return route.fulfill(
          method === 'DELETE'
            ? { status: 204 }
            : json({ setupRequired: false, user: SIGNED_IN_USER }),
        );
      }
      if (path === '/api/health') return route.fulfill(json({ status: 'up' }));

      // --- assets ---------------------------------------------------------
      if (path.startsWith('/api/assets/')) {
        const [, , , assetId, tail] = path.split('/');
        const asset = world.assets.get(assetId ?? '');
        if (tail === 'content' || tail === 'derivatives') {
          return route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
        }
        if (!asset) return route.fulfill(json({ title: 'not found' }, 404));

        if (method === 'PATCH') {
          asset.originalFilename = body().filename as string;
          return route.fulfill(json(view(world, asset)));
        }
        if (tail === 'restore') {
          asset.deletedAt = null;
          return route.fulfill(json(view(world, asset)));
        }
        if (tail === 'file') {
          // Irreversible, and only ever the second step.
          if (!asset.deletedAt) return route.fulfill(json({ title: 'not deleted' }, 409));
          world.assets.delete(asset.id);
          return route.fulfill({ status: 204 });
        }
        if (method === 'DELETE') {
          const using = world.usage(asset.id);
          if (using.length > 0 && url.searchParams.get('withItems') !== 'true') {
            return route.fulfill(
              json(
                { title: 'asset is in use', boards: using, boardCount: using.length, status: 409 },
                409,
              ),
            );
          }
          // The cascade: the items go through the operation path, board by board.
          for (const entry of using) {
            const board = world.board(entry.id);
            if (!board) continue;
            for (const item of [...board.items.values()]) {
              if (item.content.asset?.assetId === asset.id) {
                world.apply(board, { type: 'item.delete', itemId: item.id });
              }
            }
          }
          asset.deletedAt = new Date().toISOString();
          return route.fulfill({ status: 204 });
        }
        return route.fulfill(json(view(world, asset)));
      }

      if (path === '/api/assets') {
        if (method === 'POST') {
          const asset: StubAsset = {
            id: world.id(),
            originalFilename: `dropped-${world.assets.size + 1}.png`,
            mimeType: 'image/png',
            byteSize: bytes.length,
            width: 1600,
            height: 1200,
            deletedAt: null,
          };
          world.assets.set(asset.id, asset);
          return route.fulfill(json(asset, 201));
        }
        const deleted = url.searchParams.get('deleted') === 'true';
        const term = url.searchParams.get('q');
        const collection = url.searchParams.get('collection');
        let matching = [...world.assets.values()].filter((a) => Boolean(a.deletedAt) === deleted);
        if (term) matching = matching.filter((a) => a.originalFilename.includes(term));
        if (collection) {
          const members = world.members.get(collection) ?? new Set();
          matching = matching.filter((a) => members.has(a.id));
        }
        if (url.searchParams.get('sort') === 'name') {
          matching = [...matching].sort((a, b) =>
            a.originalFilename.toLowerCase().localeCompare(b.originalFilename.toLowerCase()),
          );
        } else {
          matching = [...matching].reverse();
        }
        return route.fulfill(json({ assets: matching.map((a) => view(world, a)) }));
      }

      // --- collections ----------------------------------------------------
      if (path === '/api/collections') {
        if (method === 'POST') {
          const entry = { id: world.id(), name: body().name as string };
          world.collections.set(entry.id, entry);
          world.members.set(entry.id, new Set());
          return route.fulfill(json(entry, 201));
        }
        return route.fulfill(
          json(
            [...world.collections.values()].map((c) => ({
              ...c,
              assetCount: world.members.get(c.id)?.size ?? 0,
            })),
          ),
        );
      }
      if (/^\/api\/collections\/[^/]+\/assets$/.test(path)) {
        const id = path.split('/')[3] as string;
        const members = world.members.get(id) ?? new Set<string>();
        for (const assetId of (body().assetIds as string[]) ?? []) {
          if (method === 'PUT') members.add(assetId);
          else members.delete(assetId);
        }
        world.members.set(id, members);
        return route.fulfill(json({ skipped: [] }));
      }

      // --- boards ---------------------------------------------------------
      if (path === '/api/boards') {
        if (method === 'POST') {
          return route.fulfill(json(summary(world.createBoard(body().title as string)), 201));
        }
        return route.fulfill(json([...world.boards.values()].map(summary)));
      }
      if (path.startsWith('/api/boards/')) {
        const [, , , boardId, tail] = path.split('/');
        const board = world.board(boardId ?? '');
        if (!board) return route.fulfill(json({ title: 'not found' }, 404));

        if (tail === 'duplicate') return route.fulfill(json(summary(world.duplicate(board)), 201));
        if (tail === 'snapshot') {
          return route.fulfill(
            json({
              revision: board.revision,
              items: [...board.items.values()].sort((a, b) => a.z - b.z),
              groups: [...board.groups.values()],
            }),
          );
        }
        if (tail === 'operations') {
          for (const operation of (body().operations as { body: Record<string, unknown> }[]) ??
            []) {
            world.apply(board, operation.body);
          }
          return route.fulfill(json({ revision: board.revision }));
        }
        if (method === 'PATCH') {
          board.title = body().title as string;
          return route.fulfill(json(summary(board)));
        }
        if (method === 'DELETE') {
          world.boards.delete(board.id);
          return route.fulfill({ status: 204 });
        }
        return route.fulfill(json(summary(board)));
      }

      return route.fulfill(json({ title: 'not stubbed', path }, 404));
    },
  );

  return world;
}

function view(world: Instance, asset: StubAsset) {
  return {
    id: asset.id,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    originalFilename: asset.originalFilename,
    deletedAt: asset.deletedAt,
    boards: world.usage(asset.id).length,
  };
}

function summary(board: StubBoard) {
  return {
    id: board.id,
    title: board.title,
    revision: board.revision,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ownerId: SIGNED_IN_USER.id,
  };
}

/** A real drop of real bytes, as a DataTransfer built in the page. */
async function dropFiles(page: Page, count: number, at: { x: number; y: number }) {
  const data = [...readFileSync(FIXTURE)];
  const transfer = await page.evaluateHandle(
    ([bytes, n]) => {
      const dt = new DataTransfer();
      for (let i = 0; i < (n as number); i++) {
        dt.items.add(
          new File([new Uint8Array(bytes as number[])], `drop-${i}.png`, { type: 'image/png' }),
        );
      }
      return dt;
    },
    [data, count] as const,
  );

  await page.dispatchEvent('canvas', 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'drop', {
    dataTransfer: transfer,
    clientX: at.x,
    clientY: at.y,
  });
}

async function dragAssetFromPanel(page: Page, at: { x: number; y: number }) {
  const cell = page.getByRole('region', { name: 'Library' }).locator('li button').first();
  const alt = await cell.locator('img').getAttribute('alt');
  const box = await cell.boundingBox();
  if (!box) throw new Error('no library cell');

  // The panel writes the payload on dragstart; the canvas reads it on drop.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await cell.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'dragover', { dataTransfer: transfer });
  await page.dispatchEvent('canvas', 'drop', {
    dataTransfer: transfer,
    clientX: at.x,
    clientY: at.y,
  });
  return alt;
}

async function itemCount(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
}

async function canvasCentre(page: Page) {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const panel = (page: Page) => page.getByRole('region', { name: 'Library' });

test('the whole loop: build a board, live in it, come back, and clean up', async ({ page }) => {
  test.slow();
  const world = await instance(page);

  // 1. A board, and you are in it. No ceremony between "new board" and the
  //    first image — the list does not come back at you holding what you made.
  await page.goto('/');
  await page.getByRole('textbox', { name: 'New board name' }).fill('Kitchen references');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/boards\/[0-9a-f-]+$/);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const boardUrl = page.url();

  // 2. Drop three images. They are on the board before the upload finishes, and
  //    they arrive in the library on their own.
  const centre = await canvasCentre(page);
  await dropFiles(page, 3, centre);
  await expect.poll(() => itemCount(page)).toBe(3);
  await expect.poll(() => world.assets.size).toBe(3);

  // Undo takes the whole drop back in one press, and redo restores it.
  await page.keyboard.press('Control+z');
  await expect.poll(() => itemCount(page)).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => itemCount(page)).toBe(3);

  // 3. The library is beside the canvas, and it already has what was dropped —
  //    no reload, no navigation to make it notice.
  await expect(panel(page).locator('li')).toHaveCount(3, { timeout: 10_000 });

  // Place two more without uploading anything: one dragged, one clicked.
  await dragAssetFromPanel(page, { x: centre.x - 150, y: centre.y - 100 });
  await expect.poll(() => itemCount(page)).toBe(4);
  await panel(page).locator('li button').nth(1).click();
  await expect.poll(() => itemCount(page)).toBe(5);
  // Placement is not an upload: the library still holds three images.
  expect(world.assets.size).toBe(3);

  // 4. Arrange: select everything, group it.
  await page.keyboard.press('Control+a');
  await expect.poll(async () => (await stats(page)).selected).toBe(5);
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await expect.poll(() => [...world.boards.values()][0]?.groups.size ?? 0).toBe(1);

  // 4b. One more image, dropped and immediately taken back. The item goes; the
  //     asset stays, because assets outlive boards — which is what leaves an
  //     unused image in the library for the cleanup at the end to find.
  await page.keyboard.press('Escape');
  await dropFiles(page, 1, { x: centre.x + 120, y: centre.y + 120 });
  await expect.poll(() => world.assets.size).toBe(4);
  await expect.poll(() => itemCount(page)).toBe(6);
  await page.keyboard.press('Control+z');
  await expect.poll(() => itemCount(page)).toBe(5);

  // 5. Frame it, which moves the camera and nothing else.
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await page.waitForTimeout(150);
  expect(await itemCount(page)).toBe(5);

  // 6. Leave, and come back to what was left. Nothing was ever saved by hand.
  await page.getByRole('link', { name: 'Boards' }).click();
  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
  await page.goto(boardUrl);
  await expect.poll(() => itemCount(page)).toBe(5);

  // 7. Organise in the library: rename one, and collect them.
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  const cells = page.locator('[data-testid="library-scroller"] li');
  await expect(cells).toHaveCount(4);

  // Three of the four are on the board; one is not, and the grid says which.
  await expect(page.getByText('unused').first()).toBeVisible();

  page.once('dialog', () => {});
  await page.evaluate(() => {
    window.prompt = () => 'kitchen-north-light.png';
  });
  await cells.first().locator('button').first().click();
  await page.getByRole('button', { name: 'rename' }).click();
  await expect(page.getByRole('img', { name: 'kitchen-north-light.png' })).toBeVisible();

  // Sorting by name is a first page, not a continuation of the old cursor.
  await page.getByLabel('sort').selectOption('name');
  await expect(page).toHaveURL(/[?&]sort=name/);
  await expect(cells).toHaveCount(4);

  // 8. Delete the unused one. It is reversible, so there is no dialog asking.
  const unusedId = [...world.assets.values()].find((a) => world.usage(a.id).length === 0)?.id;
  expect(unusedId).toBeTruthy();
  await selectAssetNamed(page, world, unusedId as string);
  await page.getByRole('button', { name: 'delete', exact: true }).click();
  await expect(cells).toHaveCount(3);

  // It is out of the library, not gone: the deleted view has it.
  await page.getByRole('button', { name: 'Deleted' }).click();
  await expect(page).toHaveURL(/[?&]deleted=true/);
  await expect(cells).toHaveCount(1);

  // 9. Delete one that IS on the board. Refused, and the refusal names it.
  await page.getByRole('button', { name: 'Deleted' }).click();
  await expect(cells).toHaveCount(3);
  const usedId = [...world.assets.values()].find((a) => world.usage(a.id).length > 0)?.id;
  await selectAssetNamed(page, world, usedId as string);
  await page.getByRole('button', { name: 'delete', exact: true }).click();
  await expect(page.getByText('Kitchen references')).toBeVisible();
  await expect(page.getByText(/is still on 1 board/)).toBeVisible();

  // The second act says what does not come back, in those words.
  await page.getByRole('button', { name: 'delete it from those boards too' }).click();
  await expect(page.getByText(/where it sat on each board cannot/)).toBeVisible();
  await page.getByRole('button', { name: /remove from 1 board and delete/ }).click();
  await expect(cells).toHaveCount(2);

  // The board really lost the items, through the operation path.
  await page.goto(boardUrl);
  await expect.poll(() => itemCount(page)).toBeLessThan(5);

  // 10. Restore it. The image comes back; the arrangement does not.
  await page.goto('/library?deleted=true');
  await expect(cells).toHaveCount(2);
  await selectAssetNamed(page, world, usedId as string);
  await page.getByRole('button', { name: 'restore' }).click();
  await expect(cells).toHaveCount(1);
  await page.goto('/library');
  await expect(cells).toHaveCount(3);

  // 11. Purge the one that is still deleted. The only irreversible act, and it
  //     says so in words rather than in a colour.
  await page.goto('/library?deleted=true');
  await selectAssetNamed(page, world, unusedId as string);
  const confirmations: string[] = [];
  page.on('dialog', (dialog) => {
    confirmations.push(dialog.message());
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'remove permanently' }).click();

  await expect.poll(() => world.assets.has(unusedId as string)).toBe(false);
  expect(confirmations.join(' ')).toContain('cannot be undone');
  await expect(page.getByText(/Nothing has been deleted/)).toBeVisible();
});

async function stats(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return { selected: Number(/(\d+) selected/.exec(text)?.[1] ?? 0) };
}

/**
 * Select exactly one asset, whatever the current order put it in.
 *
 * Clearing first, because clicking a cell that is ALREADY selected deselects it
 * — the behaviour the grid is supposed to have, and one a walk that selects
 * several things in a row would otherwise trip over.
 */
async function selectAssetNamed(page: Page, world: Instance, assetId: string) {
  const asset = world.assets.get(assetId);
  if (!asset) throw new Error(`no asset ${assetId}`);

  const clear = page.getByRole('button', { name: 'clear selection' });
  if (await clear.isVisible()) await clear.click();

  await page
    .locator('[data-testid="library-scroller"] li')
    .filter({ has: page.getByRole('img', { name: asset.originalFilename }) })
    .first()
    .locator('button')
    .first()
    .click();
}
