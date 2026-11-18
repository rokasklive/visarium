import { expect, type Page, test } from '@playwright/test';
import { SIGNED_IN_USER } from './session';

/**
 * The first run, and the three states an instance can boot into.
 *
 * The server half of this is SetupIT and SessionIT against real PostgreSQL —
 * the advisory lock, the adoption, the identical refusals. What has no
 * equivalent there is the BROWSER half: that a fresh instance shows one screen
 * and not the application, that claiming it lands you inside rather than back at
 * a form, that a reload does not re-open the setup route, and that signing out
 * takes you to sign-in rather than to setup.
 *
 * The API is stubbed for the same reason the persistence spec stubs it: the
 * subject here is what the SPA does with the answers, not the answers.
 */

/** An instance nobody has claimed: one screen, and it is not the application. */
async function unclaimed(page: Page): Promise<{ claimed: () => boolean }> {
  let claimed = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: claimed
        ? { setupRequired: false, user: SIGNED_IN_USER }
        : { setupRequired: true, user: null },
    }),
  );
  await page.route('**/api/setup', (route) => {
    claimed = true;
    return route.fulfill({ status: 201, json: SIGNED_IN_USER });
  });
  await stubTheApplication(page);
  return { claimed: () => claimed };
}

/** Enough of the rest of the API that the application can render once you are in. */
async function stubTheApplication(page: Page): Promise<void> {
  await page.route('**/api/boards', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/collections', (route) => route.fulfill({ json: [] }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'UP' } }));
}

test('a fresh instance shows the setup screen and nothing else', async ({ page }) => {
  await unclaimed(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Set up this instance' })).toBeVisible();
  // Not the application: there is no window in which an unclaimed instance is
  // browsable, and that includes a flash of chrome before the redirect.
  await expect(page.getByRole('link', { name: 'Library' })).toBeHidden();
  // The access model is on the screen, before anybody is invited.
  await expect(page.getByText(/can see every board and every image/)).toBeVisible();
});

test('a deep link to a board still shows setup rather than a browser error', async ({ page }) => {
  await unclaimed(page);
  await page.goto('/boards/01a01640-6b72-7d60-968b-88be186f32db');

  await expect(page.getByRole('heading', { name: 'Set up this instance' })).toBeVisible();
});

test('claiming the instance lands inside the application, not back at a form', async ({ page }) => {
  await unclaimed(page);
  await page.goto('/');

  await page.getByLabel('Your name').fill('Ada Lovelace');
  await page.getByLabel('Username').fill('ada');
  await page.getByLabel('Password').fill('a-perfectly-ordinary-passphrase');
  await page.getByRole('button', { name: 'Create the first account' }).click();

  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
  await expect(page.getByTestId('signed-in-as')).toHaveText('Ada Lovelace');
});

test('reloading a claimed instance gives the application, never setup again', async ({ page }) => {
  await unclaimed(page);
  await page.goto('/');
  await page.getByLabel('Your name').fill('Ada Lovelace');
  await page.getByLabel('Username').fill('ada');
  await page.getByLabel('Password').fill('a-perfectly-ordinary-passphrase');
  await page.getByRole('button', { name: 'Create the first account' }).click();
  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();

  await page.reload();

  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up this instance' })).toBeHidden();
});

test('signing out gives the sign-in screen rather than setup', async ({ page }) => {
  let signedIn = true;
  await page.route('**/api/session', (route) => {
    if (route.request().method() === 'DELETE') {
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: { setupRequired: false, user: signedIn ? SIGNED_IN_USER : null },
    });
  });
  await stubTheApplication(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();

  // Sign-in, NOT setup: the instance is claimed and stays claimed. Showing setup
  // here would offer to create a second first admin.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up this instance' })).toBeHidden();
});

test('a claimed instance with nobody signed in shows sign-in', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { setupRequired: false, user: null } }),
  );
  await stubTheApplication(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('a wrong password says so and keeps you on the sign-in screen', async ({ page }) => {
  await page.route('**/api/session', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        json: {
          status: 401,
          title: 'Unauthorized',
          detail: 'that username and password do not match an account',
        },
      });
    }
    return route.fulfill({ json: { setupRequired: false, user: null } });
  });
  await stubTheApplication(page);

  await page.goto('/');
  await page.getByLabel('Username').fill('ada');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The 401 here is an ANSWER, not an expired session: it must not be swallowed
  // by the session-ended handler and replaced with a fresh sign-in screen.
  await expect(page.getByRole('alert')).toContainText('do not match an account');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
