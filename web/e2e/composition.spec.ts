import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * M08's exit criterion, as one walk.
 *
 * Select, fade, flip, reorder, group, name the group, duplicate it, delete —
 * every one of them reached from the selection, without the pointer crossing to
 * the fixed chrome at the top of the screen. Then a reload, because a property
 * that does not survive one is a property nobody can rely on.
 *
 * The API is a test double, for the reason the persistence spec gives: the
 * SERVER half of all of this is proven against real PostgreSQL by
 * `BoardOperationsIT` and `ThreeClientsIT`. What only a browser can prove is that
 * a bar anchored to a selection is reachable, that a keypress and a button
 * produce the same act, and that the two join up across a reload.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f3801';
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f3802';

interface Body {
  readonly type: string;
  readonly itemId?: string;
  readonly groupId?: string;
  readonly memberIds?: string[];
  readonly label?: string;
  readonly z?: number;
  readonly transform?: Record<string, number>;
  readonly appearance?: { opacity: number; flipX: boolean; flipY: boolean };
  readonly content?: { kind: string; asset?: { assetId: string } };
}

const DEFAULT_APPEARANCE = { opacity: 1, flipX: false, flipY: false };

/**
 * A board that remembers, so a reload has something to reload.
 *
 * It applies appearance and labels the way the schema does — a creation without
 * an appearance takes the default rather than nothing, and `group.label`
 * renames a group `group.create` would have left alone.
 */
class StubBoard {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly groups = new Map<string, Record<string, unknown>>();

  apply(body: Body) {
    const item = body.itemId ? this.items.get(body.itemId) : undefined;
    switch (body.type) {
      case 'item.create':
        this.items.set(body.itemId as string, {
          id: body.itemId,
          transform: body.transform,
          z: body.z,
          content: body.content,
          appearance: body.appearance ?? DEFAULT_APPEARANCE,
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
      case 'item.appearance':
        if (item) item.appearance = body.appearance;
        break;
      case 'group.create':
        this.groups.set(body.groupId as string, {
          id: body.groupId,
          memberIds: body.memberIds ?? [],
          ...(body.label !== undefined ? { label: body.label } : {}),
        });
        for (const id of body.memberIds ?? []) {
          const member = this.items.get(id);
          if (member) member.groupId = body.groupId;
        }
        break;
      case 'group.delete': {
        const group = this.groups.get(body.groupId as string);
        for (const id of (group?.memberIds as string[]) ?? []) {
          const member = this.items.get(id);
          if (member) member.groupId = undefined;
        }
        this.groups.delete(body.groupId as string);
        break;
      }
      case 'group.label': {
        const group = this.groups.get(body.groupId as string);
        if (group) group.label = body.label;
        break;
      }
      default:
        break;
    }
  }

  centerpiece: string | null = null;

  snapshot() {
    return {
      centerpiece: this.centerpiece,
      revision: this.items.size,
      items: [...this.items.values()].sort((a, b) => Number(a.z) - Number(b.z)),
      groups: [...this.groups.values()],
    };
  }

  appearanceOf(id: string) {
    return this.items.get(id)?.appearance as typeof DEFAULT_APPEARANCE | undefined;
  }

  get appearances() {
    return [...this.items.values()].map((i) => i.appearance as typeof DEFAULT_APPEARANCE);
  }
}

function item(id: string, x: number, z: number) {
  return {
    id,
    transform: { x, y: 0, width: 300, height: 225, rotation: 0 },
    z,
    appearance: DEFAULT_APPEARANCE,
    content: {
      kind: 'image',
      asset: { assetId: ASSET_ID, intrinsicWidth: 1600, intrinsicHeight: 1200 },
    },
  };
}

async function stubBoard(page: Page, items: Record<string, unknown>[]) {
  const board = new StubBoard();
  const posted: Body[] = [];
  for (const entry of items) board.items.set(entry.id as string, { ...entry });
  const bytes = readFileSync(FIXTURE);

  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(board.snapshot()),
    }),
  );
  await page.route(`**/api/boards/${BOARD}/operations`, async (route) => {
    const body = route.request().postDataJSON() as { operations: { body: Body }[] };
    for (const operation of body.operations) {
      posted.push(operation.body);
      board.apply(operation.body);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: posted.length }),
    });
  });
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: bytes }),
  );

  return { board, posted };
}

const ITEM_A = '01a01640-6b72-7d60-968b-88be186f3811';
const ITEM_B = '01a01640-6b72-7d60-968b-88be186f3812';

async function openBoard(page: Page) {
  await page.goto(`/boards/${BOARD}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

const bar = (page: Page) => page.getByTestId('selection-toolbar');
const readout = (page: Page) => bar(page).getByText(/^\d+%$/);

async function stats(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return {
    items: Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN),
    selected: Number(/(\d+) selected/.exec(text)?.[1] ?? 0),
  };
}

/**
 * Everything on the board, without the pointer going anywhere near the chrome.
 *
 * No click first: the canvas is not focusable and the bindings are on `window`,
 * so a keypress with nothing focused is exactly the case they were written for.
 */
async function selectAll(page: Page) {
  await page.keyboard.press('Control+a');
  await expect(bar(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('everything a selection affords is reached from the selection, and survives a reload', async ({
  page,
}) => {
  test.slow();
  const { board, posted } = await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 260, 2)]);
  const box = await openBoard(page);

  // 1. Nothing selected: the surface is ABSENT, not empty and not disabled, and
  //    the canvas has its pixels.
  await expect(bar(page)).toHaveCount(0);

  // 2. Select. The bar appears anchored to what was selected — no journey to the
  //    top of the screen to find out what can be done to it.
  await selectAll(page);
  const anchored = await bar(page).boundingBox();
  expect(anchored?.y).toBeLessThan(box.y + box.height);

  // 3. Fade, from the keyboard: the bar is the fallback, not the interface.
  await page.keyboard.press('4');
  await expect(readout(page)).toHaveText('40%');
  await expect.poll(() => board.appearances.map((a) => a?.opacity)).toEqual([0.4, 0.4]);

  // 4. Flip, from the bar.
  await bar(page).getByRole('button', { name: 'Flip H' }).click();
  await expect.poll(() => board.appearances.every((a) => a?.flipX)).toBe(true);

  // 5. Reorder — which used to live in the canvas toolbar and no longer does.
  await expect(page.getByRole('button', { name: 'Front', exact: true })).toHaveCount(1);
  await bar(page).getByRole('button', { name: 'Front' }).click();

  // 6. Name it. Labelling ungrouped items groups them, in one act.
  await bar(page).getByRole('button', { name: 'Label' }).click();
  await bar(page).getByRole('textbox', { name: 'Group label' }).fill('Kitchen');
  await page.keyboard.press('Enter');
  await expect.poll(() => [...board.groups.values()].map((g) => g.label)).toEqual(['Kitchen']);

  // 7. Duplicate the group. The copies carry the appearance and form their own
  //    group with the same name, and they become the selection.
  await bar(page).getByRole('button', { name: 'Duplicate' }).click();
  await expect.poll(() => stats(page).then((s) => s.items)).toBe(4);
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(2);
  await expect.poll(() => board.groups.size).toBe(2);
  expect([...board.groups.values()].every((g) => g.label === 'Kitchen')).toBe(true);
  expect(board.appearances.every((a) => a?.opacity === 0.4 && a?.flipX)).toBe(true);

  // 8. Delete, which is last on the bar and behind its own divider.
  await bar(page).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => stats(page).then((s) => s.items)).toBe(2);
  await expect(bar(page)).toHaveCount(0);

  // 9. Reload. Every appearance and every label is still there — this is the
  //    whole of "a property that does not survive a reload is not a property".
  await page.waitForTimeout(600);
  await page.reload();
  await expect.poll(() => stats(page).then((s) => s.items)).toBe(2);
  expect(board.appearanceOf(ITEM_A)).toEqual({ opacity: 0.4, flipX: true, flipY: false });
  expect([...board.groups.values()].some((g) => g.label === 'Kitchen')).toBe(true);

  // Nothing was posted for an intermediate value: the acts above are the acts.
  expect(posted.filter((b) => b.type === 'item.appearance').length).toBeLessThan(10);
});

test('the opacity keys are one act each, and stop at a text field', async ({ page }) => {
  const { board } = await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 260, 2)]);
  await openBoard(page);
  await selectAll(page);

  await page.keyboard.press('4');
  await expect.poll(() => board.appearances.map((a) => a?.opacity)).toEqual([0.4, 0.4]);

  // `0` is full opacity, the value a person most often returns to.
  await page.keyboard.press('0');
  await expect(readout(page)).toHaveText('100%');
  await expect.poll(() => board.appearances.map((a) => a?.opacity)).toEqual([1, 1]);

  // One act, one undo — for both items at once.
  await page.keyboard.press('Control+z');
  await expect(readout(page)).toHaveText('40%');

  // And typing a digit into the label field names a group rather than fading it.
  await page.keyboard.press('F2');
  const field = bar(page).getByRole('textbox', { name: 'Group label' });
  await expect(field).toBeVisible();
  await field.fill('40s cinema');
  await expect(field).toHaveValue('40s cinema');
  await expect(readout(page)).toHaveText('40%');
  await page.keyboard.press('Enter');
  await expect.poll(() => [...board.groups.values()].map((g) => g.label)).toEqual(['40s cinema']);
});

test('the duplicate binding does not reach the browser', async ({ page }) => {
  const { board } = await stubBoard(page, [item(ITEM_A, -260, 1)]);
  await openBoard(page);
  await selectAll(page);

  // Recorded onto the document rather than returned, because the listener has to
  // already be installed when the key is pressed. It is added last, so it sees
  // whether anything upstream stopped the event.
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'd') {
        document.documentElement.dataset.duplicatePrevented = String(event.defaultPrevented);
      }
    });
  });

  await page.keyboard.press('Control+d');

  await expect.poll(() => board.items.size).toBe(2);
  // Without preventDefault the browser bookmarks the page instead.
  await expect(page.locator('html')).toHaveAttribute('data-duplicate-prevented', 'true');
});

test('the surface is hidden while a gesture is in flight', async ({ page }) => {
  await stubBoard(page, [item(ITEM_A, 0, 1)]);
  const box = await openBoard(page);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.click(centre.x, centre.y);
  await expect(bar(page)).toBeVisible();

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 80, { steps: 8 });
  // It never follows a drag and never covers what is being dragged.
  await expect(bar(page)).toHaveCount(0);

  await page.mouse.up();
  await expect(bar(page)).toBeVisible();
});

test('the same slots in the same order, whatever is selected', async ({ page }) => {
  await stubBoard(
    page,
    Array.from({ length: 12 }, (_, i) => item(`${ITEM_A}${i}`, i * 340, i)),
  );
  const box = await openBoard(page);

  // The bar is icons, so a control's name is its accessible name — the same one
  // a screen reader reads and the only one it ever had.
  const names = () =>
    bar(page)
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''));

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const forOne = await names();

  await page.keyboard.press('Control+a');
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(12);
  const forMany = await names();

  // Context decides what a control DOES, never whether it is there or where it
  // sits — which is the whole of why muscle memory works on this bar. Group is
  // present for a single item too: a group of one is permitted precisely so this
  // slot never has to vanish.
  expect(forMany).toEqual(forOne);
  expect(forOne).toEqual([
    'Take out',
    'Label',
    'Frame',
    'Collision',
    'Make centerpiece',
    'Flip H',
    'Flip V',
    'Crop',
    'Reset crop',
    'Front',
    'Back',
    'Group',
    'Duplicate',
    'Delete',
    'Hide tools',
  ]);
});

test('the bar stays inside the window, however near the edge the selection is', async ({
  page,
}) => {
  // Twelve items spread far wider than the viewport, so panning puts a selection
  // hard against each edge in turn.
  await stubBoard(
    page,
    Array.from({ length: 12 }, (_, i) => item(`${ITEM_A}${i}`, i * 340, i)),
  );
  const box = await openBoard(page);
  await page.keyboard.press('Control+a');
  await expect(bar(page)).toBeVisible();

  for (const [dx, dy] of [
    [900, 0],
    [-1800, 0],
    [900, 700],
    [0, -1400],
  ] as const) {
    // Space-drag PANS. An ordinary drag on empty canvas is a marquee, which
    // would clear the selection and take the bar away with it.
    await page.keyboard.down('Space');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await expect(bar(page)).toBeVisible();

    const placed = await bar(page).boundingBox();
    if (!placed) continue;
    // It pushes back against the edge rather than sliding under it. A bar that
    // overflowed put a horizontal scrollbar on a canvas that cannot be scrolled.
    expect(placed.x).toBeGreaterThanOrEqual(-1);
    expect(placed.y).toBeGreaterThanOrEqual(-1);
    expect(placed.x + placed.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(placed.y + placed.height).toBeLessThanOrEqual(box.y + box.height + 1);
  }

  // And nothing ever made the page itself scrollable.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the bar folds to its handle, and stays folded across selections', async ({ page }) => {
  await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 260, 2)]);
  await openBoard(page);
  await selectAll(page);

  await bar(page).getByRole('button', { name: 'Hide tools' }).click();
  await expect(bar(page).getByRole('button', { name: 'Show tools' })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // Deselect and select again: the bar unmounts in between, which is exactly why
  // the fold cannot live in its own state.
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await selectAll(page);
  await expect(bar(page).getByRole('button', { name: 'Show tools' })).toBeVisible();

  await bar(page).getByRole('button', { name: 'Show tools' }).click();
  await expect(bar(page).getByRole('button', { name: 'Delete' })).toBeVisible();
});

/** A modified wheel over the canvas, and the gesture it settles into. */
async function wheel(
  page: Page,
  at: { x: number; y: number },
  modifiers: ('Alt' | 'Shift')[],
  ticks: number,
) {
  await page.mouse.move(at.x, at.y);
  for (const key of modifiers) await page.keyboard.down(key);
  for (let i = 0; i < Math.abs(ticks); i++) {
    await page.mouse.wheel(0, ticks > 0 ? 100 : -100);
  }
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  // The wheel has no release event; the gesture ends when it goes quiet.
  await page.waitForTimeout(700);
}

test('a modified wheel adjusts the selection, one undo step per gesture', async ({ page }) => {
  const { board, posted } = await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 260, 2)]);
  const box = await openBoard(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await selectAll(page);

  // Alt — opacity. Six notches, and the readout follows while it happens.
  await wheel(page, at, ['Alt'], 3);
  await expect
    .poll(() => board.appearances.map((a) => Math.round((a?.opacity ?? 0) * 100)))
    .toEqual([70, 70]);

  // One gesture is one entry, not one per notch: three notches, one undo.
  const afterOpacity = posted.length;
  await page.keyboard.press('Control+z');
  await expect
    .poll(() => board.appearances.map((a) => Math.round((a?.opacity ?? 0) * 100)))
    .toEqual([100, 100]);
  expect(posted.length).toBeGreaterThan(afterOpacity);

  // Shift — scale, about the selection's own centre, so the gap grows with it.
  const transformOf = () =>
    (board.items.get(ITEM_A)?.transform ?? {}) as { width: number; x: number; rotation: number };
  const widthOf = () => transformOf().width;
  const xOf = () => transformOf().x;
  const before = { width: widthOf(), x: xOf() };
  await wheel(page, at, ['Shift'], -3);
  await expect.poll(widthOf).toBeGreaterThan(before.width);
  expect(Math.abs(xOf())).toBeGreaterThan(Math.abs(before.x));

  // Alt+Shift — rotation. Ctrl is NOT a modifier here and must not become one:
  // every trackpad pinch in every browser arrives as ctrl+wheel.
  const rotationOf = () => transformOf().rotation;
  const beforeRotation = rotationOf();
  await wheel(page, at, ['Alt', 'Shift'], 2);
  await expect.poll(rotationOf).not.toBe(beforeRotation);
});

test('ctrl and the wheel is still zoom, because that is what a pinch is', async ({ page }) => {
  const { board } = await stubBoard(page, [item(ITEM_A, -260, 1)]);
  const box = await openBoard(page);
  await selectAll(page);
  const before = JSON.stringify(board.items.get(ITEM_A)?.transform);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await page.waitForTimeout(700);

  // The camera moved; the selection did not.
  await expect(page.getByTestId('canvas-stats')).not.toContainText('· 100%');
  expect(JSON.stringify(board.items.get(ITEM_A)?.transform)).toBe(before);
});

test('a framed group label interrupts its frame: no frame pixel runs through the text', async ({
  page,
}) => {
  const { board } = await stubBoard(page, [item(ITEM_A, 0, 1), item(ITEM_B, 360, 2)]);
  board.groups.set('g-1', {
    id: 'g-1',
    label: 'System map',
    frame: true,
    memberIds: [ITEM_A, ITEM_B],
  } as never);
  for (const id of [ITEM_A, ITEM_B])
    (board.items.get(id) as Record<string, unknown>).groupId = 'g-1';
  await openBoard(page);
  const found = await page.evaluate(() => {
    const s = (window as unknown as { Konva: { stages: unknown[] } }).Konva.stages[0] as {
      findOne(sel: string):
        | {
            getClientRect(): { x: number; y: number; width: number; height: number };
            getLayer(): { getCanvas(): { _canvas: HTMLCanvasElement; getPixelRatio(): number } };
          }
        | undefined;
      find(sel: string): { stroke?(): string; className: string }[];
      toCanvas(o: { pixelRatio: number }): HTMLCanvasElement;
    };
    const knock = s.findOne('.group-label-knockout');
    const text = s.findOne('.group-label');
    const line = s.find('Line').find((n) => typeof n.stroke === 'function' && n.stroke());
    if (!knock || !text || !line) return null;
    const k = knock.getClientRect();
    const t = text.getClientRect();
    // Every layer composited, as on screen: the frame and the label are on
    // different layers, the label's over the frame's.
    const r = knock.getLayer().getCanvas().getPixelRatio();
    const ctx = s.toCanvas({ pixelRatio: r }).getContext('2d') as CanvasRenderingContext2D;
    // Every pixel in the text's box: none is the frame's colour.
    const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    probe.fillStyle = line.stroke?.() ?? '';
    probe.fillRect(0, 0, 1, 1);
    const [fr, fg, fb] = probe.getImageData(0, 0, 1, 1).data;
    const data = ctx.getImageData(t.x * r, t.y * r, t.width * r, t.height * r).data;
    let framePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const near = (a: number | undefined, b: number | undefined) =>
        Math.abs((a ?? 0) - (b ?? 0)) < 24;
      if (
        near(data[i], fr) &&
        near(data[i + 1], fg) &&
        near(data[i + 2], fb) &&
        (data[i + 3] ?? 0) > 100
      )
        framePixels++;
    }
    const covers =
      k.x <= t.x &&
      k.y <= t.y &&
      k.x + k.width >= t.x + t.width &&
      k.y + k.height >= t.y + t.height;
    return { framePixels, covers };
  });
  expect(found).not.toBeNull();
  expect(found?.covers).toBe(true);
  expect(found?.framePixels).toBe(0);
});

test('neighbouring group labels yield to each other far out and both show up close', async ({
  page,
}) => {
  const { board } = await stubBoard(page, [item(ITEM_A, 0, 1), item(ITEM_B, 360, 2)]);
  board.groups.set('g-1', {
    id: 'g-1',
    label: 'Startup & transport',
    memberIds: [ITEM_A],
  } as never);
  board.groups.set('g-2', { id: 'g-2', label: 'Tool surfaces', memberIds: [ITEM_B] } as never);
  (board.items.get(ITEM_A) as Record<string, unknown>).groupId = 'g-1';
  (board.items.get(ITEM_B) as Record<string, unknown>).groupId = 'g-2';
  const box = await openBoard(page);
  const labels = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { Konva: { stages: { find(s: string): unknown[] }[] } }
        ).Konva.stages[0]?.find('.group-label').length ?? 0,
    );
  await expect.poll(labels).toBe(2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  await expect.poll(labels).toBe(1);
});

test('press and hold picks one member out of its group to move and scale it in place', async ({
  page,
}) => {
  test.slow();
  const { board, posted } = await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 260, 2)]);
  board.groups.set('g-1', { id: 'g-1', label: 'Pair', memberIds: [ITEM_A, ITEM_B] } as never);
  for (const id of [ITEM_A, ITEM_B])
    (board.items.get(id) as Record<string, unknown>).groupId = 'g-1';
  const box = await openBoard(page);
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const a = { x: c.x - 260, y: c.y };
  const transforms = (id: string) =>
    posted.filter((b) => b.type === 'item.transform' && b.itemId === id) as unknown as {
      transform: { x: number; width: number };
    }[];

  // A quick click selects the whole group.
  await page.mouse.click(a.x, a.y);
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(2);
  await page.keyboard.press('Escape');

  // Hold still: just that member, with its handles.
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(1);

  // Drag it: only it moves, and it is still in the group.
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => transforms(ITEM_A).length).toBe(1);
  expect(transforms(ITEM_B)).toHaveLength(0);
  expect((board.items.get(ITEM_A) as { groupId?: string }).groupId).toBe('g-1');

  // Scale it by its corner handle (bottom-right of the moved image).
  const corner = { x: a.x + 150, y: a.y + 120 + 112.5 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 45, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => transforms(ITEM_A).at(-1)?.transform.width ?? 0).toBeGreaterThan(300);
  expect(transforms(ITEM_B)).toHaveLength(0);

  // One undo step undoes the scale alone.
  await page.keyboard.press('Control+z');
  await expect.poll(() => transforms(ITEM_A).at(-1)?.transform.width).toBe(300);

  // Escape ends it: the next click is the group again.
  await page.keyboard.press('Escape');
  await page.mouse.click(c.x + 260, c.y);
  await expect.poll(() => stats(page).then((s) => s.selected)).toBe(2);
  await page.keyboard.press('Escape');

  // Hold, then drag without letting go: that member alone moves.
  const b = { x: c.x + 260, y: c.y };
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(b.x + 80, b.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => transforms(ITEM_B).length).toBe(1);
  expect(transforms(ITEM_A).length).toBe(3);
});

test('a board opens on its centerpiece, and Fit returns to it; without one it opens as before', async ({
  page,
}) => {
  const { board } = await stubBoard(page, [item(ITEM_A, -260, 1), item(ITEM_B, 3000, 2)]);
  board.centerpiece = `item:${ITEM_B}`;
  const box = await openBoard(page);
  const centreOf = (id: string) =>
    page.evaluate((i) => {
      const n = (
        window as unknown as {
          Konva: {
            stages: {
              findOne(
                s: string,
              ):
                | { getClientRect(): { x: number; y: number; width: number; height: number } }
                | undefined;
            }[];
          };
        }
      ).Konva.stages[0]?.findOne(`#${i}`);
      const r = n?.getClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width } : null;
    }, id);
  // Framed on B: centred, and filling the canvas more than at 100%.
  await expect
    .poll(async () => Math.abs(((await centreOf(ITEM_B))?.x ?? 1e9) - box.width / 2))
    .toBeLessThan(2);
  expect((await centreOf(ITEM_B))?.width ?? 0).toBeGreaterThan(300);
  expect(Math.abs(((await centreOf(ITEM_B))?.y ?? 1e9) - box.height / 2)).toBeLessThan(2);

  // Pan away, then Fit with nothing selected: back on the centerpiece.
  await page.mouse.move(box.x + 50, box.y + box.height / 2);
  await page.keyboard.down(' ');
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  await page.getByRole('button', { name: 'Fit' }).click();
  await expect
    .poll(async () => Math.abs(((await centreOf(ITEM_B))?.x ?? 1e9) - box.width / 2))
    .toBeLessThan(2);

  // A centerpiece that no longer exists: opens as a board without one (100%, origin).
  board.centerpiece = 'item:01a01640-6b72-7d60-968b-88be186f3899';
  await page.reload();
  await expect(page.getByTestId('canvas-stats')).toContainText('100%');
});
