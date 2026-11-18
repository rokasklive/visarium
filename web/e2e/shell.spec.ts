import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * These assert the wiring, not the product: the app boots, routes work, and the
 * canvas virtualises. The canvas has its own suite in `canvas.spec.ts`.
 */

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
  // The boards list, answered as empty: this spec's subject is the shell, and a
  // route that 401s because no backend is running reads as a session ending.
  await page.route(
    (url) => url.pathname === '/api/boards',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
});

test('boots and navigates', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
});

test('sidebar collapses', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Sidebar' });
  await expect(page.getByRole('navigation', { name: 'Collections' })).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('navigation', { name: 'Collections' })).toBeHidden();
});
