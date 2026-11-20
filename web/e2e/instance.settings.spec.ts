import { expect, type Page, test } from '@playwright/test';
import { SIGNED_IN_USER, signedIn } from './session';

/**
 * Instance Settings (instance-administration): who sees the page, which
 * sections and actions each role gets, and setting up a sign-in provider. The
 * API is stubbed; `server/tests/api.rs` holds the server to the same rules.
 */

const ADA = { ...SIGNED_IN_USER, role: 'admin', admin: true };
const MO = {
  ...SIGNED_IN_USER,
  id: 'mo-1',
  username: 'mo',
  displayName: 'Mo',
  role: 'moderator',
  admin: false,
};
const BOB = {
  ...SIGNED_IN_USER,
  id: 'bob-1',
  username: 'bob',
  displayName: 'Bob',
  role: 'member',
  admin: false,
};

async function asStaff(page: Page, me: Record<string, unknown>) {
  await signedIn(page, me, { sharingEnabled: true });
  await page.route('**/api/boards', (route) => route.fulfill({ json: [] }));
  await page.route(
    (url) => url.pathname === '/api/accounts',
    (route) => route.fulfill({ json: [ADA, MO, BOB] }),
  );
  await page.route(
    (url) => url.pathname === '/api/invitations',
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname === '/api/shares',
    (route) => route.fulfill({ json: [] }),
  );
}

test('a member has no Instance Settings', async ({ page }) => {
  await signedIn(page, BOB);
  await page.route('**/api/boards', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Instance' })).toHaveCount(0);
  await page.goto('/instance');
  await expect(page.getByTestId('instance-not-staff')).toBeVisible();
});

test('a moderator acts on members only and never sees sign-in setup', async ({ page }) => {
  let providersAsked = false;
  await page.route('**/api/instance/providers', (route) => {
    providersAsked = true;
    return route.fulfill({ status: 403, json: {} });
  });
  await asStaff(page, MO);
  await page.goto('/');
  await page.getByRole('link', { name: 'Instance' }).click();
  const nav = page.getByRole('navigation', { name: 'Instance Settings sections' });
  await expect(nav.getByRole('link')).toHaveText(['Accounts', 'Invitations', 'Share links']);

  const accounts = page.getByTestId('accounts');
  await expect(accounts.getByRole('button', { name: 'Deactivate Bob' })).toBeVisible();
  await expect(accounts.getByRole('button', { name: /Deactivate Ada/ })).toHaveCount(0);
  await expect(accounts.getByRole('button', { name: /reset link for Ada/ })).toHaveCount(0);
  await expect(accounts.getByRole('combobox')).toHaveCount(0);
  // Moderators invite members only, so there is no role to pick.
  await expect(page.getByLabel('Role', { exact: true })).toHaveCount(0);
  expect(providersAsked).toBe(false);
});

test('an admin sets up Google with the redirect URI to register, then removes it', async ({
  page,
}) => {
  await asStaff(page, ADA);
  let providers: Record<string, unknown>[] = [];
  let saved: unknown = null;
  await page.route('**/api/instance/providers', (route) =>
    route.fulfill({
      json: { providers, publicUrl: 'https://visarium.example.com', passwordEnabled: true },
    }),
  );
  await page.route('**/api/instance/providers/*', async (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      saved = {
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      };
      providers = [
        {
          id: 'google',
          name: 'Google',
          issuer: 'https://accounts.google.com',
          clientId: 'cid',
          hasSecret: true,
          enabled: true,
          fromEnv: false,
          redirectUri: 'https://visarium.example.com/auth/oidc/google/callback',
          linkedAccounts: 2,
        },
      ];
      return route.fulfill({ json: providers[0] });
    }
    if (!route.request().url().includes('confirm=true')) {
      return route.fulfill({
        status: 409,
        json: {
          title: 'Confirm removal',
          detail:
            '2 account(s) sign in with google, and 1 of them would have no other way in. Send confirm=true to remove it.',
        },
      });
    }
    providers = [];
    return route.fulfill({ status: 204 });
  });

  await page.goto('/instance');
  const section = page.locator('#sign-in');
  await section.getByRole('button', { name: 'Add a provider' }).click();
  await section.getByRole('button', { name: 'Google' }).click();
  await expect(page.getByTestId('redirect-uri')).toHaveValue(
    'https://visarium.example.com/auth/oidc/google/callback',
  );
  await expect(section.getByLabel('Issuer URL')).toHaveCount(0);
  await section.getByLabel('Client id').fill('cid');
  await section.getByLabel('Client secret').fill('shh');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(() => saved)
    .toEqual({
      path: '/api/instance/providers/google',
      body: { name: 'Google', clientId: 'cid', clientSecret: 'shh' },
    });

  const providerList = page.getByTestId('providers');
  await expect(providerList).toContainText('Google');
  await providerList.getByRole('button', { name: 'Remove Google' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Remove provider' });
  await expect(ask).toContainText('1 of them would have no other way in');
  await ask.getByRole('button', { name: 'Yes, remove Google' }).click();
  await expect(providerList).not.toContainText('Google');
});
