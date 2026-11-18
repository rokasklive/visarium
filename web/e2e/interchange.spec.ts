import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * M09's exit criterion: a selection leaving the browser, and coming back.
 *
 * What only a browser can prove is here and nothing else is. A real
 * `DataTransfer` written by a real `dragstart`, a real `navigator.clipboard`
 * with real permissions, and the ordering rule that decides whether a paste is a
 * placement or an upload. The unit tests own the payload arithmetic; the server
 * half of the header is `AssetUploadIT`'s.
 *
 * What no automated test can see is the far side: a file landing on a desktop,
 * and a system clipboard read by another application. That is Q18's manual
 * matrix, recorded in OPEN_QUESTIONS rather than asserted here.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f3901';
const ASSET_A = '01a01640-6b72-7d60-968b-88be186f3902';
const ASSET_B = '01a01640-6b72-7d60-968b-88be186f3903';
const ITEM_A = '01a01640-6b72-7d60-968b-88be186f3911';
const ITEM_B = '01a01640-6b72-7d60-968b-88be186f3912';

/** The names the content endpoint declares — one of them outside US-ASCII. */
const NAMES: Record<string, string> = {
  [ASSET_A]: 'north-light.png',
  [ASSET_B]: 'kitchen-窗.png',
};

interface Body {
  readonly type: string;
  readonly itemId?: string;
  readonly content?: { kind: string; asset?: { assetId: string } };
}

function item(id: string, assetId: string, x: number, z: number) {
  return {
    id,
    transform: { x, y: 0, width: 300, height: 225, rotation: 0 },
    z,
    appearance: { opacity: 1, flipX: false, flipY: false },
    content: { kind: 'image', asset: { assetId, intrinsicWidth: 1600, intrinsicHeight: 1200 } },
  };
}

/**
 * A board that records what was posted to it, and a library that answers.
 *
 * `posted` IS the revision: one entry per operation the board accepted. The
 * read-only claim below is asserted against its length rather than against the
 * board looking unchanged.
 */
async function stubBoard(
  page: Page,
  options: {
    uploadFails?: boolean;
    contentDelayMs?: number;
    recordName?: string;
    /** Stand in for a `…/content` response cached before the header existed. */
    headerless?: boolean;
  } = {},
) {
  const bytes = readFileSync(FIXTURE);
  const items = new Map<string, Record<string, unknown>>();
  for (const entry of [item(ITEM_A, ASSET_A, -260, 1), item(ITEM_B, ASSET_B, 260, 2)]) {
    items.set(entry.id, entry);
  }
  const posted: Body[] = [];
  const uploads: string[] = [];

  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        revision: posted.length,
        items: [...items.values()].sort((a, b) => Number(a.z) - Number(b.z)),
        groups: [],
      }),
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Body }[] };
    for (const operation of body.operations) posted.push(operation.body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: posted.length }),
    });
  });

  // An upload is the thing this milestone must never do by accident. The same
  // path answers the library query, so only the POST is counted.
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assets: [] }),
      });
      return;
    }
    uploads.push(route.request().method());
    if (options.uploadFails) {
      await route.fulfill({ status: 507, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: ASSET_A,
        mimeType: 'image/png',
        byteSize: bytes.length,
        width: 1600,
        height: 1200,
        originalFilename: 'foreign.png',
      }),
    });
  });

  // Registered general to specific: Playwright prefers the last route that matches.
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );
  await page.route('**/api/assets/*/content', async (route) => {
    const assetId = /assets\/([^/]+)\/content/.exec(route.request().url())?.[1] ?? '';
    // An original is megabytes; a stub is instant. The delay is how a test says
    // "this is a real one" and is the whole subject of the readiness tests.
    if (options.contentDelayMs) {
      await new Promise((resume) => setTimeout(resume, options.contentDelayMs));
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: options.headerless
        ? {}
        : {
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(
              NAMES[assetId] ?? 'unknown.png',
            )}`,
          },
      body: bytes,
    });
  });
  await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, (route) => {
    const assetId = /assets\/([^/?]+)/.exec(route.request().url())?.[1] ?? '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: assetId,
        mimeType: 'image/png',
        byteSize: bytes.length,
        width: 1600,
        height: 1200,
        originalFilename: options.recordName ?? NAMES[assetId] ?? 'unknown.png',
      }),
    });
  });

  return { posted, uploads, bytes };
}

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

const bar = (page: Page) => page.getByTestId('selection-toolbar');
const takeOut = (page: Page) => bar(page).getByRole('button', { name: 'Take out' });
const notice = (page: Page) => page.getByTestId('interchange-notice');

async function stats(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return {
    items: Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN),
    selected: Number(/(\d+) selected/.exec(text)?.[1] ?? 0),
  };
}

async function selectAll(page: Page) {
  await page.keyboard.press('Control+a');
  await expect(bar(page)).toBeVisible();
}

interface Written {
  assets: string;
  text: string;
  files: { name: string; size: number; type: string }[];
}

/**
 * A real `dragstart` on the control, and what it wrote.
 *
 * Hovered first, because that IS the gesture: a pointer entering the control
 * warms the originals, and `dragstart` is synchronous with no await in it. The
 * warm is a fetch, so the first attempt can genuinely be early — hence a poll
 * with a fresh transfer each time rather than a sleep for a number nobody could
 * justify.
 */
async function dragOut(page: Page, files = 2): Promise<Written> {
  await takeOut(page).hover();
  let written: Written | undefined;
  await expect
    .poll(
      async () => {
        const handle = await page.evaluateHandle(() => new DataTransfer());
        await takeOut(page).dispatchEvent('dragstart', { dataTransfer: handle });
        written = await handle.evaluate((dt) => ({
          assets: dt.getData('application/x-visarium-assets'),
          text: dt.getData('text/plain'),
          files: [...dt.files].map((f) => ({ name: f.name, size: f.size, type: f.type })),
        }));
        await handle.dispose();
        return written.files.length;
      },
      { timeout: 10_000 },
    )
    .toBe(files);
  return written as Written;
}

/** A paste, built in the page and dispatched where the handler actually listens. */
async function paste(page: Page, build: { text?: string; file?: number[] }) {
  await page.evaluate(({ text, file }) => {
    const transfer = new DataTransfer();
    if (text !== undefined) transfer.setData('text/plain', text);
    if (file !== undefined) {
      transfer.items.add(new File([new Uint8Array(file)], 'foreign.png', { type: 'image/png' }));
    }
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
  }, build);
}

/** A real drop on the canvas, carrying whatever a caller wants it to carry. */
async function drop(
  page: Page,
  at: { x: number; y: number },
  build: { file?: number[]; assetId?: string },
) {
  await page.evaluate(
    ({ x, y, file, assetId }) => {
      const transfer = new DataTransfer();
      if (assetId !== undefined) {
        transfer.setData(
          'application/x-visarium-assets',
          JSON.stringify([{ assetId, width: 1600, height: 1200 }]),
        );
      }
      if (file !== undefined) {
        transfer.items.add(new File([new Uint8Array(file)], 'outside.png', { type: 'image/png' }));
      }
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
      canvas.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, clientX: x, clientY: y }),
      );
    },
    { x: at.x, y: at.y, file: build.file, assetId: build.assetId },
  );
}

test.beforeEach(async ({ page, context }) => {
  // The Clipboard API needs a secure context AND permission. localhost is the
  // first; this is the second. A self-hosted instance over plain HTTP has
  // neither, which is the case `copySelection` reports rather than swallows.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signedIn(page);
});

test('a selection leaves as its originals and comes back as a placement', async ({ page }) => {
  test.slow();
  const { posted, uploads, bytes } = await stubBoard(page);
  await openBoard(page);
  const origin = new URL(page.url()).origin;
  await selectAll(page);

  // 1. Drag out. Three payloads on one transfer, in the order a reader should
  //    prefer them.
  const transfer = await dragOut(page);

  expect(JSON.parse(transfer.assets).map((a: { assetId: string }) => a.assetId)).toEqual([
    ASSET_A,
    ASSET_B,
  ]);
  expect(transfer.text.split('\n')).toEqual([
    `${origin}/api/assets/${ASSET_A}/content`,
    `${origin}/api/assets/${ASSET_B}/content`,
  ]);

  // 2. The files are the ORIGINALS: the original name, including one outside
  //    US-ASCII, and the original byte count — not a derivative tier and not a
  //    re-encode. Bottom of the z-order first, so a multi-file drop lands in the
  //    order the board shows.
  expect(transfer.files).toEqual([
    { name: NAMES[ASSET_A], size: bytes.length, type: 'image/png' },
    { name: NAMES[ASSET_B], size: bytes.length, type: 'image/png' },
  ]);

  // 3. Copy. Recorded through the real API rather than in place of it, so the
  //    permission, the secure context and the `ClipboardItem` are all genuine.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const write = clipboard.write.bind(clipboard);
    (window as unknown as { copied: string[][] }).copied = [];
    clipboard.write = async (items) => {
      (window as unknown as { copied: string[][] }).copied.push(items.flatMap((i) => i.types));
      return write(items);
    };
  });
  await takeOut(page).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string[][] }).copied))
    .toEqual([['image/png', 'text/plain']]);
  // A copy that carried the original's format is routine success, and routine
  // success is silent.
  await expect(notice(page)).toHaveCount(0);

  // 4. Paste it back. The clipboard carries an image AND our URL text, and the
  //    URL text wins: two items are PLACED from assets already stored, and
  //    nothing is uploaded.
  const before = (await stats(page)).items;
  await paste(page, { text: transfer.text, file: [...bytes] });

  await expect.poll(() => stats(page).then((s) => s.items)).toBe(before + 2);
  expect(uploads).toEqual([]);
  await expect
    .poll(() =>
      posted.filter((b) => b.type === 'item.create').map((b) => b.content?.asset?.assetId),
    )
    .toEqual([ASSET_A, ASSET_B]);
});

test('taking a selection out changes nothing', async ({ page }) => {
  const { posted, uploads } = await stubBoard(page);
  await openBoard(page);
  await selectAll(page);

  // A real change first, so the undo has something to find — and so that
  // "nothing happened" cannot pass by the board having been empty.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  const revision = posted.length;

  await dragOut(page);
  await takeOut(page).click();
  await page.waitForTimeout(500);

  // The two numbers, not "the board looks unchanged": the revision, and the
  // depth of the undo history. Neither gesture is an operation, so neither moved.
  expect(posted.length).toBe(revision);

  await page.keyboard.press('Control+z');
  // ONE press undid the move, which is only true if the drag and the copy each
  // occupied no undo step.
  await expect.poll(() => posted.length).toBeGreaterThan(revision);
  expect(posted.at(-1)?.type).toBe('item.transform');
  expect(uploads).toEqual([]);
});

test('an item with nothing stored cannot be taken out, and the interface says why', async ({
  page,
}) => {
  const { bytes } = await stubBoard(page, { uploadFails: true });
  const box = await openBoard(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // A failed upload leaves the item exactly as a slow one does: a placeholder
  // with no asset id, and therefore nothing to hand over.
  await drop(page, at, { file: [...bytes] });
  await expect.poll(() => stats(page).then((s) => s.items)).toBe(3);
  await expect(page.getByTestId('upload-failures')).toBeVisible({ timeout: 15_000 });

  // It is topmost, so a click at the drop point lands on it and on nothing else.
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(1);

  await takeOut(page).click();

  await expect(notice(page)).toContainText('Not stored yet');
});

test('letting an export go over the board it came from does nothing', async ({ page }) => {
  const { posted } = await stubBoard(page);
  const canvas = await openBoard(page);
  await selectAll(page);
  const before = await stats(page);

  // Take out sits a few pixels above the selection, so it sits over the canvas:
  // the resting place of any drag that never leaves the window is the board it
  // started on. Treating that as a placement duplicated the whole selection.
  const handle = await page.evaluateHandle(() => new DataTransfer());
  await takeOut(page).hover();
  await takeOut(page).dispatchEvent('dragstart', { dataTransfer: handle });
  await page.evaluate(
    ([dt, x, y]) => {
      const element = document.querySelector('canvas') as HTMLCanvasElement;
      const transfer = dt as DataTransfer;
      element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
      element.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          clientX: x as number,
          clientY: y as number,
        }),
      );
    },
    [handle, canvas.x + canvas.width / 2, canvas.y + canvas.height / 2] as const,
  );
  await page.waitForTimeout(600);

  expect(await stats(page)).toEqual(before);
  expect(posted.filter((b) => b.type === 'item.create')).toEqual([]);
});

/** A drag with a real mouse, which is the only kind the browser actually starts. */
async function mouseDrag(page: Page, walkMs: number) {
  await page.evaluate(() => {
    (window as unknown as { drags: number[] }).drags = [];
    window.addEventListener('dragstart', (e) => {
      (window as unknown as { drags: number[] }).drags.push(
        (e as DragEvent).dataTransfer?.files.length ?? -1,
      );
    });
  });
  // The pointer's journey from the canvas to the bar. It IS the head start, and
  // pretending it is zero is what made the first version of this look correct.
  await page.waitForTimeout(walkMs);
  const box = await takeOut(page).boundingBox();
  if (!box) throw new Error('no control');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + i * 14, at.y + i * 11);
  await page.mouse.up();
  await page.waitForTimeout(200);
  return page.evaluate(() => (window as unknown as { drags: number[] }).drags);
}

const looksReady = (page: Page) =>
  takeOut(page).evaluate((el) => !el.className.includes('ink-disabled'));

test('selecting is what fetches the originals, so the first real drag carries them', async ({
  page,
}) => {
  // Warming on hover lost this race almost every time: a person presses within a
  // couple of hundred milliseconds of arriving, and an original is megabytes. The
  // selection is the earliest honest signal, and it precedes the press by the
  // pointer's whole journey.
  await stubBoard(page, { contentDelayMs: 200 });
  await openBoard(page);
  await selectAll(page);

  expect(await mouseDrag(page, 500)).toEqual([2]);
  expect(await looksReady(page)).toBe(true);
});

test('the dragged file is named by the asset record, not by the cached bytes', async ({ page }) => {
  // `…/content` is immutable for a year and the library grid renders that same
  // URL as an <img>, so the browser answers this fetch from a cache that may
  // predate the header entirely — and that never hears about a rename. A file
  // called `<uuid>.webp` in somebody's word processor is what that looked like.
  await stubBoard(page, { headerless: true, recordName: 'north-light.png' });
  await openBoard(page);
  await selectAll(page);

  const transfer = await dragOut(page);

  expect(transfer.files.map((f) => f.name)).toEqual(['north-light.png', 'north-light.png']);
});

test('a control with nothing to hand over says so rather than declining silently', async ({
  page,
}) => {
  await stubBoard(page, { contentDelayMs: 5_000 });
  await openBoard(page);
  await selectAll(page);

  // No drag begins at all — the browser is never asked to start one that would
  // have to be cancelled, which is what "it does nothing" looked like before.
  expect(await mouseDrag(page, 400)).toEqual([]);
  expect(await looksReady(page)).toBe(false);
  await expect(takeOut(page)).toHaveAttribute('title', /fetching the originals/i);

  // Copy is unaffected: it fetches its own bytes and can wait for them.
  await takeOut(page).click();
  await expect(notice(page)).toHaveCount(0);
});

test('a paste of our URLs into a text field belongs to the field', async ({ page }) => {
  const { posted } = await stubBoard(page);
  await openBoard(page);
  await selectAll(page);
  const transfer = await dragOut(page);
  const before = (await stats(page)).items;

  // Name a group, then paste into the field. The URL payload is text, and a
  // field somebody is typing in owns its own paste.
  await page.keyboard.press('F2');
  const field = bar(page).getByRole('textbox', { name: 'Group label' });
  await expect(field).toBeVisible();
  await field.focus();
  await page.evaluate((text) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true }),
    );
  }, transfer.text);

  await page.waitForTimeout(400);
  expect((await stats(page)).items).toBe(before);
  expect(posted.filter((b) => b.type === 'item.create')).toEqual([]);
});

test('a paste from outside is still an upload, exactly as it was', async ({ page }) => {
  const { uploads, bytes } = await stubBoard(page);
  await openBoard(page);
  const before = (await stats(page)).items;

  // The arrival regression this milestone owes: putting files on Visarium's own
  // transfers must not have changed what a transfer from ANYWHERE ELSE means.
  await paste(page, { file: [...bytes] });

  await expect.poll(() => stats(page).then((s) => s.items)).toBe(before + 1);
  await expect.poll(() => uploads).toEqual(['POST']);
});

test('a drop from outside is still an upload, and a drop of ours is a placement', async ({
  page,
}) => {
  const { uploads, bytes } = await stubBoard(page);
  const box = await openBoard(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = (await stats(page)).items;

  await drop(page, at, { file: [...bytes] });
  await expect.poll(() => stats(page).then((s) => s.items)).toBe(before + 1);
  await expect.poll(() => uploads).toEqual(['POST']);

  // The same drop carrying a Visarium payload beside the file. Ours wins, and
  // the file it also carries is not uploaded a second time.
  const after = (await stats(page)).items;
  await drop(page, at, { file: [...bytes], assetId: ASSET_B });

  await expect.poll(() => stats(page).then((s) => s.items)).toBe(after + 1);
  expect(uploads).toEqual(['POST']);
});

test('the other person is told nothing, because nothing happened', async ({ page, browser }) => {
  const { posted } = await stubBoard(page);
  await openBoard(page);

  const second = await browser.newContext();
  const other = await second.newPage();
  await signedIn(other);
  await stubBoard(other);
  await openBoard(other);
  const before = await stats(other);

  await selectAll(page);
  await dragOut(page);
  await takeOut(page).click();
  const revision = posted.length;

  await other.waitForTimeout(1500);

  // Nothing posted, so nothing to announce — and the other board is what it was.
  expect(await stats(other)).toEqual(before);
  expect(posted.length).toBe(revision);
  await second.close();
});
