import { execSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { call, fixture, idsOf, newBoard, SERVER, showBoard } from './apps-server';

/**
 * Profiles the live-view cap (openspec canvas-apps-live 11.3): a board with 4
 * large chart apps live and 20 more apps drawn as cards, against the same
 * board with Canvas apps off (cards only). Reports frame times while the board
 * pans and the browser's memory, for the record in the design notes.
 *
 *   VISARIUM_PROFILE=1, against a real server (`just e2e-apps`-style).
 */

test.skip(!SERVER || !process.env.VISARIUM_PROFILE, 'profiling runs only when asked');

const NOTE = `# Sales\n\n| Quarter | North | South | East |\n| --- | --- | --- | --- |\n| Q1 | 120 | 80 | 60 |\n| Q2 | 150 | 95 | 70 |\n| Q3 | 170 | 110 | 90 |\n| Q4 | 160 | 120 | 100 |\n`;

/** Chromium's resident memory, all its processes, in MB. */
function browserMb(): number {
  const out = execSync("ps -axo rss=,command= | grep 'ms-playwright' | grep -v grep", {
    encoding: 'utf8',
  });
  return Math.round(
    out
      .trim()
      .split('\n')
      .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0] ?? 0), 0) / 1024,
  );
}

/** Frame intervals (ms) while the board pans for about 3 s. */
async function pan(
  page: Page,
): Promise<{ p50: number; p95: number; slow: number; frames: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { frames_: number[] };
    w.frames_ = [];
    let last = performance.now();
    const tick = (t: number) => {
      w.frames_.push(t - last);
      last = t;
      if (w.frames_.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(640, 400);
  for (let i = 0; i < 90; i++) {
    await page.mouse.wheel(i < 45 ? 12 : -12, 0);
    await page.waitForTimeout(33);
  }
  const f = await page.evaluate(() =>
    (window as unknown as { frames_: number[] }).frames_.slice(1),
  );
  const sorted = [...f].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round((sorted[Math.floor(q * (sorted.length - 1))] ?? 0) * 10) / 10;
  return { p50: at(0.5), p95: at(0.95), slow: f.filter((x) => x > 33).length, frames: f.length };
}

test('4 live chart apps and 20 cards: frame times and memory', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const request = page.request;
  await page.goto(SERVER);
  const board = await newBoard(page, 'Profile');
  const b = { board };
  await call(request, 'item_create', { ...b, kind: 'note', source: NOTE });
  const html = fixture('sales');
  for (let i = 1; i <= 24; i++)
    await call(request, 'app_create', {
      ...b,
      title: `Chart ${i}`,
      html,
      right_of: i === 1 ? 'n1' : `a${i - 1}`,
    });
  for (let i = 1; i <= 24; i++)
    await call(request, 'link', {
      ...b,
      from: 'n1',
      to: `a${i}`,
      type: 'feeds',
      view: 'tables',
      path: '0',
      name: 'sales',
    });
  // Four large charts in a row, the twenty others small beneath them.
  const id = await idsOf(page, board);
  const ops = [];
  for (let i = 1; i <= 24; i++) {
    const big = i <= 4;
    const t = big
      ? { x: (i - 1) * 520, y: 0, width: 480, height: 360, rotation: 0 }
      : {
          x: ((i - 5) % 10) * 210,
          y: 460 + Math.floor((i - 5) / 10) * 170,
          width: 150,
          height: 110,
          rotation: 0,
        };
    ops.push({
      operationId: crypto.randomUUID(),
      baseRevision: 0,
      body: { type: 'item.transform', itemId: id(`a${i}`), transform: t },
    });
  }
  ops.push({
    operationId: crypto.randomUUID(),
    baseRevision: 0,
    body: {
      type: 'item.transform',
      itemId: id('n1'),
      transform: { x: -500, y: 0, width: 320, height: 240, rotation: 0 },
    },
  });
  const xsrf =
    (await page.context().cookies(SERVER)).find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  const moved = await request.post(`${SERVER}/api/boards/${board}/operations`, {
    headers: { 'x-xsrf-token': xsrf },
    data: { operations: ops },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  const all = Array.from({ length: 24 }, (_, i) => id(`a${i + 1}`));

  const measure = async (apps: boolean) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.addInitScript(
      (on) => localStorage.setItem('visarium.labs.canvasApps', on ? 'on' : 'off'),
      apps,
    );
    await p.goto(SERVER);
    await showBoard(p, board, all);
    if (apps) await expect(p.getByTestId('app-view')).toHaveCount(4, { timeout: 30_000 });
    await p.waitForTimeout(3000);
    const mb = browserMb();
    const frames = await pan(p);
    const live = await p.getByTestId('app-view').count();
    await ctx.close();
    return { live, mb, ...frames };
  };
  const cards = await measure(false);
  const live = await measure(true);
  const result = {
    cards,
    live,
    cpus: execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim(),
  };
  console.log(`PROFILE ${JSON.stringify(result)}`);
});
