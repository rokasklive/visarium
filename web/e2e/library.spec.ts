import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { sidebarOpen, signedIn } from './session';

/**
 * The library at a size nobody would sit and create by hand.
 *
 * The API is stubbed rather than run, because what has no unit-test equivalent
 * here is the browser half: a real scroll over a real layout, and how many
 * elements actually end up in the document. The server half — the query, the
 * cursor, the escaping — is covered by `LibraryIT`, where it can be checked
 * against real SQL.
 *
 * This is M04's exit criterion, and it is measured rather than asserted, the
 * way M01's node ceiling was.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');

/** Several thousand: the size the roadmap's exit criterion names. */
const LIBRARY_SIZE = 5_000;
const PAGE_SIZE = 100;

interface StubAsset {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  originalFilename: string;
}

/** A deterministic library, paged exactly the way the server pages it. */
function libraryOf(size: number): StubAsset[] {
  return Array.from({ length: size }, (_, index) => ({
    // A UUID-shaped id; only its uniqueness matters to the grid.
    id: `01a01640-6b72-7d60-968b-${String(index).padStart(12, '0')}`,
    mimeType: 'image/png',
    byteSize: 1024,
    width: 512,
    height: 512,
    originalFilename: index === 4_242 ? 'borealis-needle.png' : `ref-${index}.png`,
  }));
}

async function stubLibrary(
  page: Page,
  options: { size?: number; collections?: { id: string; name: string; assetCount: number }[] } = {},
) {
  const bytes = readFileSync(FIXTURE);
  const all = libraryOf(options.size ?? LIBRARY_SIZE);
  const collections = options.collections ?? [];

  await page.route(
    (url) => url.pathname === '/api/collections',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(collections),
      });
    },
  );

  // Bytes for any derivative tier or original.
  await page.route(
    (url) => url.pathname.startsWith('/api/assets/'),
    async (route) => {
      await route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
    },
  );

  // Matched on the path, not on a glob: the unfiltered library is requested
  // with no query string at all, and `**/api/assets?*` silently misses it.
  await page.route(
    (url) => url.pathname === '/api/assets',
    async (route) => {
      const url = new URL(route.request().url());
      const term = url.searchParams.get('q');
      const collection = url.searchParams.get('collection');

      let matching = all;
      if (term) matching = matching.filter((a) => a.originalFilename.includes(term));
      // The stub's collection holds the first three assets, which is enough to
      // show one asset under several collections.
      if (collection) matching = matching.slice(0, 3);

      // Keyset paging, as the server does it: the cursor names the last row sent.
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? matching.findIndex((a) => a.id === cursor) + 1 : 0;
      const slice = matching.slice(start, start + PAGE_SIZE);
      const last = slice.at(-1);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assets: slice,
          ...(last && start + PAGE_SIZE < matching.length ? { nextCursor: last.id } : {}),
        }),
      });
    },
  );
}

const cells = (page: Page) => page.locator('[data-testid="library-scroller"] li');

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await sidebarOpen(page);
});

test('draws a bounded number of elements however large the library is', async ({ page }) => {
  await stubLibrary(page);
  await page.goto('/library');
  await expect(cells(page).first()).toBeVisible();

  // The library holds 5,000; the DOM must not.
  const atTop = await cells(page).count();
  expect(atTop).toBeLessThan(100);

  // The scrollbar describes every asset loaded, not just the rows in the DOM.
  // It cannot describe the whole 5,000: the server returns no total, because a
  // count(*) over the filtered set on every page is the expensive half of a
  // query whose point is to be cheap. So the region grows as pages arrive.
  const scroller = page.getByTestId('library-scroller');
  const loadedHeight = await scroller.evaluate((el) => el.scrollHeight);
  const clientHeight = await scroller.evaluate((el) => el.clientHeight);
  expect(loadedHeight).toBeGreaterThan(clientHeight);

  // Scroll to the end, which pulls further pages in.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(async () => {
    expect(await scroller.evaluate((el) => el.scrollHeight)).toBeGreaterThan(loadedHeight);
  }).toPass();

  // The whole claim: more assets loaded, the same number of elements drawn.
  expect(await cells(page).count()).toBeLessThan(100);
});

test('scrolling down and back shows the same rows again', async ({ page }) => {
  await stubLibrary(page);
  await page.goto('/library');
  await expect(cells(page).first()).toBeVisible();

  const firstNames = await cells(page).locator('img').first().getAttribute('alt');

  const scroller = page.getByTestId('library-scroller');
  await scroller.evaluate((el) => {
    el.scrollTop = 4_000;
  });
  await expect(async () => {
    expect(await cells(page).locator('img').first().getAttribute('alt')).not.toBe(firstNames);
  }).toPass();

  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(cells(page).locator('img').first()).toHaveAttribute('alt', firstNames ?? '');
});

test('requests a derivative tier rather than the original bytes', async ({ page }) => {
  await stubLibrary(page);
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/assets/')) requested.push(request.url());
  });

  await page.goto('/library');
  await expect(cells(page).first()).toBeVisible();

  expect(requested.length).toBeGreaterThan(0);
  // A 96px cell never needs the original, at any device pixel ratio.
  expect(requested.every((url) => url.includes('/derivatives/'))).toBe(true);
  // And the tier is one the ladder actually generates.
  expect(requested.every((url) => /\/derivatives\/(64|256|512)$/.test(url))).toBe(true);
});

/** The first half of M04's exit criterion: findable at several thousand. */
test('finds one asset by name among several thousand', async ({ page }) => {
  await stubLibrary(page);
  await page.goto('/library');
  await expect(cells(page).first()).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search the library' }).fill('borealis');

  await expect(cells(page)).toHaveCount(1);
  await expect(cells(page).locator('img')).toHaveAttribute('alt', 'borealis-needle.png');
  // The filter is in the URL, so this view is a link.
  await expect(page).toHaveURL(/[?&]q=borealis/);

  // And it survives a reload, rather than quietly resetting.
  await page.reload();
  await expect(cells(page)).toHaveCount(1);
});

test('the back button undoes a filter', async ({ page }) => {
  await stubLibrary(page);
  await page.goto('/library?q=borealis');
  await expect(cells(page)).toHaveCount(1);

  await page.goto('/library?q=ref-1');
  await expect(cells(page).first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/[?&]q=borealis/);
});

/** The second half: one asset under several collections, without duplication. */
test('one asset appears under several collections', async ({ page }) => {
  const collections = [
    { id: '01a01640-0000-7000-8000-000000000001', name: 'CRT Heads', assetCount: 3 },
    { id: '01a01640-0000-7000-8000-000000000002', name: 'Ancient Technology', assetCount: 3 },
    { id: '01a01640-0000-7000-8000-000000000003', name: 'Borealis', assetCount: 3 },
  ];
  await stubLibrary(page, { size: 200, collections });
  await page.goto('/library');

  const sidebar = page.getByRole('navigation', { name: 'Collections' });
  await expect(sidebar.getByRole('button', { name: 'CRT Heads', exact: true })).toBeVisible();

  for (const collection of collections) {
    await sidebar.getByRole('button', { name: collection.name, exact: true }).click();
    await expect(page.getByRole('heading', { name: collection.name })).toBeVisible();
    // The same asset, in each of them, exactly once per view.
    await expect(cells(page)).toHaveCount(3);
    await expect(cells(page).locator('img[alt="ref-0.png"]')).toHaveCount(1);
  }
});

test('states an empty library and an empty filter in words', async ({ page }) => {
  await stubLibrary(page, { size: 0 });
  await page.goto('/library');

  await expect(page.getByText('No images yet.')).toBeVisible();
  // No illustration, no empty-state artwork.
  await expect(page.locator('main svg')).toHaveCount(0);

  await stubLibrary(page, { size: 200 });
  await page.goto('/library?q=nothing-matches-this');
  await expect(page.getByText('Nothing matches this filter.')).toBeVisible();
});

test('the sidebar states its own emptiness plainly', async ({ page }) => {
  await stubLibrary(page, { size: 10, collections: [] });
  await page.goto('/library');

  const sidebar = page.getByRole('navigation', { name: 'Collections' });
  await expect(sidebar.getByText('No collections yet.')).toBeVisible();
  // Creating one asks for a name and nothing else.
  await expect(sidebar.getByRole('textbox', { name: 'New collection name' })).toBeVisible();
});

test('collections are listed with their counts', async ({ page }) => {
  await stubLibrary(page, {
    size: 50,
    collections: [
      { id: '01a01640-0000-7000-8000-000000000001', name: 'Interiors', assetCount: 42 },
    ],
  });
  await page.goto('/library');

  const sidebar = page.getByRole('navigation', { name: 'Collections' });
  await expect(sidebar.getByRole('button', { name: 'Interiors', exact: true })).toBeVisible();
  await expect(sidebar.getByText('42')).toBeVisible();
});
