import { expect, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * The OAuth consent page (mcp-oauth): an MCP app asks to work on the boards;
 * the person sees who asks and where the answer goes, chooses the grant, and
 * the browser goes back to the app. The API is stubbed; `server/tests/oauth.rs`
 * holds the server to the same contract.
 */

const REQUEST = 'req-1';
const BACK = 'https://claude.example/api/mcp/auth_callback';

async function stub(page: import('@playwright/test').Page, answered: { body?: unknown }) {
  await signedIn(page);
  await page.route(`**/api/oauth/requests/${REQUEST}`, (route) =>
    route.fulfill({
      json: { clientName: 'Claude', redirectHost: 'claude.example', clientHost: null },
    }),
  );
  await page.route('**/api/oauth/consent', (route) => {
    answered.body = route.request().postDataJSON();
    const { approve } = answered.body as { approve: boolean };
    return route.fulfill({
      json: {
        redirect: approve
          ? `${BACK}?code=c0de&state=st&iss=http%3A%2F%2Flocalhost`
          : `${BACK}?error=access_denied&state=st`,
      },
    });
  });
  await page.route(`${BACK}**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>back in the app</p>' }),
  );
}

test('approving an app sends the browser back to it with a code, grant chosen', async ({
  page,
}) => {
  const answered: { body?: unknown } = {};
  await stub(page, answered);
  await page.goto(`/oauth/consent?request=${REQUEST}`);
  await expect(page.getByTestId('consent-client')).toContainText('Claude');
  await expect(page.getByTestId('consent-client')).toContainText('Ada Lovelace');
  await expect(page.getByTestId('consent-redirect')).toContainText('claude.example');
  const grant = page.getByTestId('consent-manage-boards').getByRole('checkbox');
  await expect(grant).not.toBeChecked();
  await grant.check();
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(`${BACK}**`);
  expect(page.url()).toContain('code=c0de');
  expect(answered.body).toEqual({ request: REQUEST, approve: true, manageBoards: true });
});

test('cancelling tells the app no', async ({ page }) => {
  const answered: { body?: unknown } = {};
  await stub(page, answered);
  await page.goto(`/oauth/consent?request=${REQUEST}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(`${BACK}**`);
  expect(page.url()).toContain('error=access_denied');
  expect(answered.body).toEqual({ request: REQUEST, approve: false, manageBoards: false });
});

test('an expired request says to start again', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/oauth/requests/*', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      json: {
        title: 'Not found',
        status: 404,
        detail: 'this sign-in request has expired; start again from the app',
      },
    }),
  );
  await page.goto('/oauth/consent?request=gone');
  await expect(page.getByText('start again from the app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
});
