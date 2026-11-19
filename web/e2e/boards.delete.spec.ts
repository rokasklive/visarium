import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Deleting a board asks in place, never through `window.confirm`: the
 * desktop app's webview has no JavaScript dialogs, and there `confirm()`
 * returns false without showing anything, so a delete behind it never
 * happened. The stub below makes this browser behave the same way.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f9d00';

test('a board is deleted after a yes asked in place, even where confirm() always says no', async ({
  page,
}) => {
  await signedIn(page);
  await page.addInitScript(() => {
    window.confirm = () => false;
  });
  const deletes: string[] = [];
  let boards = [
    {
      id: BOARD,
      title: 'Old plans',
      ownerId: null,
      revision: 0,
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:00:00Z',
      createdByAgent: null,
    },
  ];
  await page.route(
    (url) => url.pathname === '/api/boards',
    (route) => route.fulfill({ json: boards }),
  );
  await page.route(`**/api/boards/${BOARD}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deletes.push(BOARD);
    boards = [];
    await route.fulfill({ status: 204 });
  });

  await page.goto('/');
  const row = page.getByRole('listitem').filter({ hasText: 'Old plans' });
  await row.hover();
  await row.getByRole('button', { name: 'delete' }).click();
  await expect(page.getByRole('group', { name: /Delete "Old plans"\?/ })).toBeVisible();

  // Cancel deletes nothing and puts the button back.
  await page.getByRole('button', { name: 'cancel' }).click();
  expect(deletes).toEqual([]);

  await row.hover();
  await row.getByRole('button', { name: 'delete' }).click();
  await page.getByRole('button', { name: 'yes' }).click();
  await expect.poll(() => deletes).toEqual([BOARD]);
  await expect(page.getByText('Old plans')).toHaveCount(0);
});
