import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Settings → Agents (ADR-0031): minting a token, seeing its secret once,
 * copying it, and revoking it. The API is stubbed; `server/tests/api.rs` holds
 * the server to the same contract.
 */

test('a person makes an agent token, copies it once, sees it listed and revokes it', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
  const SECRET = 'a'.repeat(64);
  let tokens: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[] = [];
  await page.route('**/api/agent-tokens', async (route) => {
    if (route.request().method() === 'POST') {
      const { label } = route.request().postDataJSON() as { label: string };
      const made = { id: 'tok-1', label, createdAt: '2026-11-19T10:00:00Z' };
      tokens = [{ ...made, lastUsedAt: null }];
      return route.fulfill({ status: 201, json: { ...made, token: SECRET } });
    }
    return route.fulfill({ json: tokens });
  });
  let revoked = '';
  await page.route('**/api/agent-tokens/*', (route) => {
    revoked = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    tokens = [];
    return route.fulfill({ status: 204 });
  });

  await page.goto('/settings');
  const section = page.getByTestId('agents-section');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('agent-snippet-claude')).toHaveValue(
    /^claude mcp add --transport http visarium http:\/\/localhost:\d+\/mcp --header/,
  );

  await section.getByLabel('New token for').fill('Claude Code on laptop');
  await section.getByRole('button', { name: 'Make token' }).click();
  await expect(page.getByTestId('agent-token-secret')).toHaveValue(SECRET);
  await expect(page.getByTestId('agent-snippet-claude')).toHaveValue(
    new RegExp(`Bearer ${SECRET}"$`),
  );
  await expect(page.getByTestId('agent-snippet-json')).toHaveValue(new RegExp(`Bearer ${SECRET}`));
  await section.getByRole('button', { name: 'Copy Token' }).click();
  await expect(section.getByRole('button', { name: 'Copy Token' })).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SECRET);
  // Every snippet copies, and its field selects for a manual copy too.
  await section.getByRole('button', { name: 'Copy Claude Code' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('claude mcp add');
  await section.getByRole('button', { name: 'Copy Any MCP client' }).click();
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).mcpServers.visarium.type,
  ).toBe('http');
  await page.getByTestId('agent-snippet-json').focus();
  expect(
    await page.evaluate(
      () =>
        window.getSelection()?.toString() ||
        (document.activeElement as HTMLTextAreaElement).selectionEnd,
    ),
  ).toBeTruthy();

  const row = page.getByTestId('agent-token');
  await expect(row).toContainText('Claude Code on laptop');
  await expect(row).toContainText('not used yet');

  // After a reload the secret is gone for good; the token is still listed.
  await page.reload();
  await expect(page.getByTestId('agent-token')).toContainText('Claude Code on laptop');
  await expect(page.getByTestId('agent-token-secret')).toHaveCount(0);

  await page.getByRole('button', { name: 'Revoke Claude Code on laptop' }).click();
  await expect(page.getByTestId('agent-token')).toHaveCount(0);
  expect(revoked).toBe('tok-1');
});

test('apps connected by sign-in are listed, and the address alone is offered', async ({ page }) => {
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
  await page.route('**/.well-known/oauth-protected-resource/mcp', (route) =>
    route.fulfill({ json: { resource: 'http://localhost/mcp' } }),
  );
  await page.route('**/api/agent-tokens', (route) =>
    route.fulfill({
      json: [
        {
          id: 'c-1',
          label: 'ChatGPT',
          createdAt: '2026-11-19T10:00:00Z',
          lastUsedAt: '2026-11-19T11:00:00Z',
          manageBoards: false,
          connectedBySignIn: true,
        },
      ],
    }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('agent-url')).toHaveValue(/^http:\/\/localhost:\d+\/mcp$/);
  const row = page.getByTestId('agent-token');
  await expect(row).toContainText('ChatGPT');
  await expect(row.getByTestId('agent-token-signed-in')).toHaveText('connected by sign-in');
  await expect(row.getByRole('button', { name: 'Revoke ChatGPT' })).toBeVisible();
});

test('without OAuth, connecting by address is not offered', async ({ page }) => {
  await signedIn(page);
  for (const path of ['/api/sessions', '/api/accounts', '/api/invitations', '/api/agent-tokens']) {
    await page.route(
      (url) => url.pathname === path,
      (route) => route.fulfill({ json: [] }),
    );
  }
  await page.route('**/api/accounts/me/identities', (route) =>
    route.fulfill({ json: { hasPassword: true, identities: [] } }),
  );
  await page.route('**/.well-known/oauth-protected-resource/mcp', (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('agent-snippet-claude')).toBeVisible();
  await expect(page.getByTestId('agent-url')).toHaveCount(0);
});

test('in the desktop app, the local port moves at once', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        setupRequired: false,
        singleUser: true,
        user: {
          id: 'me',
          username: 'local',
          displayName: 'You',
          admin: true,
          deactivatedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    }),
  );
  // The desktop app's bridge, as desktop/src/local_port.rs answers it. 48001
  // is "not free"; anything else moves.
  await page.addInitScript(() => {
    const calls: { cmd: string; args?: { value?: number } | undefined }[] = [];
    let port = { preferred: 47821, actual: 47821, default: 47821 };
    (window as unknown as { __calls: typeof calls }).__calls = calls;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke(cmd: string, args?: { value?: number }) {
        calls.push({ cmd, args });
        if (cmd === 'local_port') return Promise.resolve(port);
        if (cmd === 'set_local_port') {
          if (args?.value === 48001)
            return Promise.reject({
              kind: 'local',
              message: 'port 48001 is not free; choose another',
            });
          port = { ...port, preferred: args?.value ?? 0, actual: args?.value ?? 0 };
          return Promise.resolve(port);
        }
        return Promise.reject(new Error(`no command ${cmd}`));
      },
    };
  });
  await page.goto('/settings');
  const control = page.getByTestId('local-port');
  await expect(control.getByLabel('Local port')).toHaveValue('47821');
  await expect(page.getByTestId('agent-snippet-claude')).toHaveValue(
    /^claude mcp add --transport http visarium http:\/\/localhost:\d+\/mcp$/,
  );

  await control.getByLabel('Local port').fill('80');
  await control.getByRole('button', { name: 'Save' }).click();
  await expect(control.getByRole('alert')).toContainText('1024 to 65535');

  await control.getByLabel('Local port').fill('48001');
  await control.getByRole('button', { name: 'Save' }).click();
  await expect(control.getByRole('alert')).toContainText('port 48001 is not free');

  await control.getByLabel('Local port').fill('48000');
  await control.getByRole('button', { name: 'Save' }).click();
  await expect(control.getByRole('status')).toContainText('Moving to port 48000');
  const calls = await page.evaluate(
    () => (window as unknown as { __calls: { cmd: string; args?: { value?: number } }[] }).__calls,
  );
  expect(calls.filter((c) => c.cmd === 'set_local_port').map((c) => c.args?.value)).toEqual([
    48001, 48000,
  ]);
  expect(calls.some((c) => c.cmd === 'restart_app')).toBe(false);
});

test('a token is let manage boards, and the grant survives a reload', async ({ page }) => {
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
  let manageBoards = false;
  let patched: unknown;
  await page.route('**/api/agent-tokens', (route) =>
    route.fulfill({
      json: [
        {
          id: 'tok-1',
          label: 'Claude',
          createdAt: '2026-11-19T10:00:00Z',
          lastUsedAt: null,
          manageBoards,
        },
      ],
    }),
  );
  await page.route('**/api/agent-tokens/tok-1', (route) => {
    patched = route.request().postDataJSON();
    manageBoards = (patched as { manageBoards: boolean }).manageBoards;
    return route.fulfill({ status: 204 });
  });

  await page.goto('/settings');
  const grant = page.getByLabel('Let Claude manage boards');
  await expect(grant).not.toBeChecked();
  await grant.click();
  await expect(grant).toBeChecked();
  expect(patched).toEqual({ manageBoards: true });
  await page.reload();
  await expect(page.getByLabel('Let Claude manage boards')).toBeChecked();
});

test('in the desktop app, local agents are let manage boards with one switch', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        setupRequired: false,
        singleUser: true,
        user: {
          id: 'me',
          username: 'local',
          displayName: 'You',
          admin: true,
          deactivatedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    }),
  );
  let on = false;
  await page.route('**/api/agent-settings', (route) => {
    if (route.request().method() === 'PATCH') {
      on = (route.request().postDataJSON() as { localAgentsManageBoards: boolean })
        .localAgentsManageBoards;
    }
    return route.fulfill({ json: { localAgentsManageBoards: on } });
  });

  await page.goto('/settings');
  const box = page.getByTestId('local-manage-boards').getByRole('checkbox');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await page.reload();
  await expect(page.getByTestId('local-manage-boards').getByRole('checkbox')).toBeChecked();
});
