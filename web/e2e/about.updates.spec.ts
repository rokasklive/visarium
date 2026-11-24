import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Settings → About in the desktop app (openspec desktop/updates): checking
 * hands an update to the app's own prompt window, and automatic checks can be
 * turned off. The bridge is stubbed as desktop/src/about.rs answers it.
 */

async function desktop(page: import('@playwright/test').Page, offer: 'available' | 'current') {
  await signedIn(page);
  for (const path of ['/api/sessions', '/api/accounts', '/api/invitations']) {
    await page.route(
      (url) => url.pathname === path,
      (route) => route.fulfill({ json: [] }),
    );
  }
  await page.route('**/api/accounts/me/identities', (route) =>
    route.fulfill({ json: { hasPassword: true, identities: [] } }),
  );
  await page.addInitScript((status) => {
    const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
    let automatic = true;
    (window as unknown as { __calls: typeof calls }).__calls = calls;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke(cmd: string, args?: Record<string, unknown>) {
        calls.push({ cmd, args });
        if (cmd === 'local_port')
          return Promise.resolve({ preferred: 47821, actual: 47821, default: 47821 });
        if (cmd === 'check_for_updates') return Promise.resolve({ status });
        if (cmd === 'update_preferences') {
          if (typeof args?.automatic === 'boolean') automatic = args.automatic;
          return Promise.resolve({ automatic });
        }
        return Promise.reject(new Error(`no command ${cmd}`));
      },
    };
  }, offer);
  await page.goto('/settings');
  return page.getByRole('region', { name: 'About' });
}

test('an update found from About goes to the prompt window', async ({ page }) => {
  const about = await desktop(page, 'available');
  await about.getByRole('button', { name: 'Check for Updates' }).click();
  await expect(about.getByRole('status')).toHaveText('');
  // No inline install, and no "reopen Visarium" detour.
  await expect(about.getByRole('button', { name: /Install/ })).toHaveCount(0);
});

test('nothing new says so inline', async ({ page }) => {
  const about = await desktop(page, 'current');
  await about.getByRole('button', { name: 'Check for Updates' }).click();
  await expect(about.getByRole('status')).toHaveText('Visarium is up to date.');
});

test('automatic checks can be turned off', async ({ page }) => {
  const about = await desktop(page, 'current');
  const box = about.getByLabel('Check for updates automatically');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __calls: { cmd: string; args?: { automatic?: boolean } }[] }).__calls,
  );
  expect(
    calls.filter((c) => c.cmd === 'update_preferences').map((c) => c.args?.automatic),
  ).toContain(false);
});
