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
  let visionAsked = false;
  await page.route('**/api/instance/vision**', (route) => {
    visionAsked = true;
    return route.fulfill({ status: 403, json: {} });
  });
  await asStaff(page, MO);
  await page.goto('/');
  await page.getByRole('link', { name: 'Instance' }).click();
  const nav = page.getByRole('navigation', { name: 'Instance Settings sections' });
  await expect(nav.getByRole('link')).toHaveText([
    'Accounts',
    'Invitations',
    'Share links',
    'Storage',
  ]);

  const accounts = page.getByTestId('accounts');
  await expect(accounts.getByRole('button', { name: 'Deactivate Bob' })).toBeVisible();
  await expect(accounts.getByRole('button', { name: /Deactivate Ada/ })).toHaveCount(0);
  await expect(accounts.getByRole('button', { name: /reset link for Ada/ })).toHaveCount(0);
  await expect(accounts.getByRole('combobox')).toHaveCount(0);
  // Moderators invite members only, so there is no role to pick.
  await expect(page.getByLabel('Role', { exact: true })).toHaveCount(0);
  expect(providersAsked).toBe(false);
  await expect(page.getByTestId('vision-section')).toHaveCount(0);
  expect(visionAsked).toBe(false);
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

test('an admin tests and saves a vision model, and the key never comes back', async ({ page }) => {
  await asStaff(page, ADA);
  await page.route('**/api/instance/providers', (route) =>
    route.fulfill({ json: { providers: [], publicUrl: null, passwordEnabled: true } }),
  );
  const base = {
    prompt: '',
    defaultPrompt: 'CAPTION: …',
    waiting: 0,
    described: 0,
    failed: 0,
    lastError: null,
    fromEnv: false,
  };
  let setting: Record<string, unknown> = {
    ...base,
    configured: false,
    enabled: false,
    hasKey: false,
  };
  let saved: Record<string, unknown> | null = null;
  await page.route('**/api/instance/vision', (route) => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      const body = saved as { baseUrl: string; model: string; apiKey?: string };
      setting = {
        ...base,
        configured: true,
        enabled: true,
        baseUrl: body.baseUrl,
        model: body.model,
        hasKey: Boolean(body.apiKey),
        waiting: 12,
        described: 3,
      };
    }
    return route.fulfill({ json: setting });
  });
  let tested: Record<string, unknown> | null = null;
  await page.route('**/api/instance/vision/test', (route) => {
    tested = route.request().postDataJSON();
    return route.fulfill({
      json:
        (tested as { model: string }).model === 'missing'
          ? { ok: false, error: "the endpoint answered 404 Not Found: model 'missing' not found" }
          : {
              ok: true,
              caption: 'Three coloured shapes',
              description: 'A red square.',
              visibleText: '',
            },
    });
  });

  await page.goto('/instance#vision');
  const section = page.getByTestId('vision-section');
  await expect(section.getByTestId('vision-warning')).toContainText('every image is sent');
  await section.getByLabel('Base URL (up to /v1)').fill('http://ollama:11434/v1');
  await section.getByLabel('Model').fill('missing');
  await section.getByRole('button', { name: 'Test' }).click();
  await expect(section.getByTestId('vision-test-result')).toContainText(
    "model 'missing' not found",
  );
  await section.getByLabel('Model').fill('qwen2.5vl:7b');
  await section.getByLabel('API key (optional)').fill('sk-secret');
  await section.getByRole('button', { name: 'Test' }).click();
  await expect(section.getByTestId('vision-test-result')).toContainText('Three coloured shapes');
  expect(tested).toMatchObject({ baseUrl: 'http://ollama:11434/v1', apiKey: 'sk-secret' });

  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByTestId('vision-status')).toHaveText('On · 3 described · 12 waiting');
  expect(saved).toMatchObject({ model: 'qwen2.5vl:7b', apiKey: 'sk-secret', enabled: true });
  // The key field empties, and says one is set.
  await expect(section.getByLabel(/one is set/)).toHaveValue('');
});

test('a vision model set by the environment is read-only', async ({ page }) => {
  await asStaff(page, ADA);
  await page.route('**/api/instance/providers', (route) =>
    route.fulfill({ json: { providers: [], publicUrl: null, passwordEnabled: true } }),
  );
  await page.route('**/api/instance/vision', (route) =>
    route.fulfill({
      json: {
        configured: true,
        enabled: true,
        fromEnv: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
        hasKey: true,
        prompt: '',
        defaultPrompt: '',
        waiting: 0,
        described: 40,
        failed: 2,
        lastError: { message: 'the endpoint answered 429', at: '2026-11-21T10:00:00Z' },
      },
    }),
  );
  await page.goto('/instance#vision');
  const section = page.getByTestId('vision-section');
  await expect(section.getByTestId('vision-from-env')).toContainText('gpt-5-mini');
  await expect(section.getByTestId('vision-form')).toHaveCount(0);
  await expect(section.getByTestId('vision-status')).toHaveText(
    'On · 40 described · 0 waiting · 2 given up on',
  );
  await expect(section.getByTestId('vision-last-error')).toContainText('429');
});
