import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { SIGNED_IN_USER, signedIn } from './session';

/**
 * The browser half of ADR-0025–0027: provider sign-in, invitations, the desktop
 * handoff page, the account screen, and read-only share links.
 *
 * The server half — PKCE, state, the flow cookie, who may reach what — is
 * server/tests/api.rs against an in-process OpenID provider. What is left for
 * the browser is what the SPA does with the answers: which screen, which
 * buttons, where the token goes, and that it leaves the address bar.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bench', 'ref-3.png');
const BOARD = '01a01640-6b72-7d60-968b-88be186f32db';
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f32dc';
const GOOGLE = { id: 'google', name: 'Google' };

async function signedOut(page: Page, extra: Record<string, unknown> = {}) {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        setupRequired: false,
        user: null,
        passwordEnabled: true,
        providers: [GOOGLE],
        ...extra,
      },
    }),
  );
}

// --- sign-in (7.1) ---------------------------------------------------------

test('sign-in offers each provider beside the password form', async ({ page }) => {
  await signedOut(page);
  await page.goto('/boards/abc');

  await expect(page.getByLabel('Password')).toBeVisible();
  const google = page.getByRole('link', { name: 'Continue with Google' });
  await expect(google).toHaveAttribute(
    'href',
    '/auth/oidc/google/start?intent=sign-in&return=%2Fboards%2Fabc',
  );
});

test('chrome text does not select or open a context menu; fields still do', async ({ page }) => {
  await signedOut(page);
  await page.goto('/');

  const field = page.getByLabel('Username');
  await expect(field).toBeVisible();
  const probe = (selector: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) as Element;
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return { select: getComputedStyle(el).userSelect, menuBlocked: event.defaultPrevented };
    }, selector);
  expect(await probe('.wordmark')).toEqual({ select: 'none', menuBlocked: true });
  expect(await probe('input[autocomplete="username"]')).toEqual({
    select: 'text',
    menuBlocked: false,
  });
});

test('an SSO-only instance shows the providers and no password form', async ({ page }) => {
  await signedOut(page, { passwordEnabled: false });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeHidden();
});

test('a provider sign-in that failed says why, in words', async ({ page }) => {
  await signedOut(page);
  await page.goto('/sign-in?error=no-account');

  await expect(page.getByRole('alert')).toContainText('Ask an admin for an invitation');
});

test('setup can be claimed through a provider', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { setupRequired: true, user: null, passwordEnabled: true, providers: [GOOGLE] },
    }),
  );
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Set up this instance' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
    'href',
    /intent=claim/,
  );
});

// --- invitations (7.2) -----------------------------------------------------

test('an invitation link joins with a password, and its token leaves the address bar', async ({
  page,
}) => {
  let joined = false;
  let redeemed: Record<string, unknown> | undefined;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        setupRequired: false,
        user: joined ? SIGNED_IN_USER : null,
        passwordEnabled: true,
        providers: [GOOGLE],
      },
    }),
  );
  await page.route('**/api/invitations/inspect', (route) =>
    route.fulfill({
      json: {
        purpose: 'join',
        admin: false,
        note: 'For Ada',
        expiresAt: '2030-01-01T00:00:00Z',
        passwordEnabled: true,
      },
    }),
  );
  await page.route('**/api/invitations/redeem', (route) => {
    redeemed = route.request().postDataJSON();
    joined = true;
    return route.fulfill({ status: 201, json: SIGNED_IN_USER });
  });
  await page.route('**/api/boards', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/collections', (route) => route.fulfill({ json: [] }));

  await page.goto('/invite#the-secret-token');
  await expect(page.getByRole('heading', { name: 'Join this instance' })).toBeVisible();
  expect(page.url()).not.toContain('the-secret-token');
  await expect(page.getByRole('button', { name: 'Join with Google' })).toBeVisible();

  await page.getByLabel('Your name').fill('Ada Lovelace');
  await page.getByLabel('Username').fill('ada');
  await page.getByLabel('Password').fill('a-perfectly-ordinary-passphrase');
  await page.getByRole('button', { name: 'Create my account' }).click();

  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
  expect(redeemed).toMatchObject({ token: 'the-secret-token', username: 'ada' });
});

test('a dead invitation says so', async ({ page }) => {
  await signedOut(page);
  await page.route('**/api/invitations/inspect', (route) =>
    route.fulfill({
      status: 410,
      contentType: 'application/problem+json',
      json: {
        status: 410,
        detail: 'this link has expired; ask an admin for a new one',
        code: 'invite-expired',
      },
    }),
  );
  await page.goto('/invite#old');
  await expect(page.getByRole('alert')).toContainText('has expired');
});

// --- the desktop handoff page ----------------------------------------------

test('the desktop page asks, then sends the browser back to the app on loopback', async ({
  page,
}) => {
  await signedIn(page);
  let asked: Record<string, unknown> | undefined;
  await page.route('**/api/device/authorize', (route) => {
    asked = route.request().postDataJSON();
    return route.fulfill({ json: { redirect: 'http://127.0.0.1:49152/callback?code=c&state=s1' } });
  });
  await page.route('http://127.0.0.1:49152/**', (route) =>
    route.fulfill({ body: 'back in the app' }),
  );

  await page.goto(
    '/device?port=49152&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=s1&label=Visarium%20Desktop%20on%20studio-mac',
  );
  await expect(
    page.getByText('Allow Visarium Desktop on studio-mac to sign in as Ada Lovelace?'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page.getByText('back in the app')).toBeVisible();
  expect(asked).toMatchObject({
    port: 49152,
    state: 's1',
    label: 'Visarium Desktop on studio-mac',
  });
});

test('the desktop naming a provider skips the sign-in page; one it lacks does not', async ({
  page,
}) => {
  await signedOut(page);
  let started = '';
  await page.route('**/auth/oidc/**', (route) => {
    started = route.request().url();
    return route.fulfill({ body: 'at the provider' });
  });

  await page.goto('/device?port=49152&challenge=c&state=s1&provider=nope');
  await expect(page.getByLabel('Password')).toBeVisible();

  await page.goto('/device?port=49152&challenge=c&state=s1&provider=google');
  await expect(page.getByText('at the provider')).toBeVisible();
  const back = new URL(started).searchParams.get('return');
  expect(started).toContain('/auth/oidc/google/start?intent=sign-in');
  expect(back).toBe('/device?port=49152&challenge=c&state=s1&provider=google');
});

test('an unclaimed instance is claimed through the named provider, back to /device', async ({
  page,
}) => {
  await signedOut(page, { setupRequired: true });
  let started = '';
  await page.route('**/auth/oidc/**', (route) => {
    started = route.request().url();
    return route.fulfill({ body: 'at the provider' });
  });

  await page.goto('/device?port=49152&challenge=c&state=s1&provider=google');
  await expect(page.getByText('at the provider')).toBeVisible();
  expect(started).toContain('/auth/oidc/google/start?intent=claim');
  expect(new URL(started).searchParams.get('return')).toBe(
    '/device?port=49152&challenge=c&state=s1&provider=google',
  );
});

// --- the account screen (7.3) ----------------------------------------------

test('settings lists sign-in methods and sessions, and signs out the others', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        setupRequired: false,
        user: SIGNED_IN_USER,
        passwordEnabled: true,
        providers: [GOOGLE],
        sharingEnabled: true,
      },
    }),
  );
  await page.route('**/api/accounts/me/identities', (route) =>
    route.fulfill({ json: { hasPassword: true, identities: [] } }),
  );
  let ended = false;
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'DELETE') {
      ended = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: [
        {
          id: 'a',
          kind: 'browser',
          label: 'Safari on macOS',
          createdAt: '2026-11-01T00:00:00Z',
          lastSeenAt: '2026-11-17T00:00:00Z',
          expiresAt: '2026-12-17T00:00:00Z',
          current: true,
        },
        {
          id: 'b',
          kind: 'device',
          label: 'Visarium Desktop on studio-mac',
          createdAt: '2026-11-01T00:00:00Z',
          lastSeenAt: '2026-11-10T00:00:00Z',
          expiresAt: '2027-02-08T00:00:00Z',
          current: false,
        },
      ],
    });
  });
  await page.route('**/api/accounts', (route) => route.fulfill({ json: [SIGNED_IN_USER] }));
  await page.route('**/api/invitations', (route) => route.fulfill({ json: [] }));

  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Add Google sign-in' })).toHaveAttribute(
    'href',
    /intent=link/,
  );
  await expect(page.getByText('Visarium Desktop on studio-mac')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
  await expect.poll(() => ended).toBe(true);
  await expect(page.getByRole('button', { name: 'Make an invitation link' })).toBeVisible();
});

// --- sharing (7.4, 7.5) ----------------------------------------------------

function snapshot() {
  return {
    revision: 1,
    groups: [],
    items: [
      {
        id: '01a01640-6b72-7d60-968b-88be186f3201',
        transform: { x: 0, y: 0, width: 300, height: 225, rotation: 0 },
        z: 1,
        content: {
          kind: 'image',
          asset: { assetId: ASSET_ID, intrinsicWidth: 1600, intrinsicHeight: 1200 },
        },
      },
    ],
  };
}

test('a board can be shared, and the link is shown once', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { setupRequired: false, user: SIGNED_IN_USER, providers: [], sharingEnabled: true },
    }),
  );
  await page.route(`**/api/boards/${BOARD}/snapshot`, (route) =>
    route.fulfill({ json: snapshot() }),
  );
  await page.route('**/api/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(FIXTURE) }),
  );
  const links: Record<string, unknown>[] = [];
  await page.route(`**/api/boards/${BOARD}/shares`, (route) => {
    if (route.request().method() === 'POST') {
      const made = {
        id: 's1',
        canvasId: BOARD,
        label: 'client review',
        createdAt: '2026-11-17T00:00:00Z',
        expiresAt: '2026-11-24T00:00:00Z',
        hasPassphrase: false,
      };
      links.push(made);
      return route.fulfill({ status: 201, json: { ...made, link: '/s#share-token' } });
    }
    return route.fulfill({ json: links });
  });

  await page.goto(`/boards/${BOARD}`);
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByLabel('Label').fill('client review');
  await page.getByRole('button', { name: '7 days' }).click();
  await page.getByRole('button', { name: 'Make a link' }).click();

  await expect(page.getByLabel('The new link')).toHaveValue(/\/s#share-token$/);
  await expect(page.getByRole('button', { name: 'Revoke client review' })).toBeVisible();
});

test('a share link opens the board read-only, with no application around it', async ({ page }) => {
  let redeemedWith: Record<string, unknown> | undefined;
  await page.route('**/api/shared/session', (route) => {
    redeemedWith = route.request().postDataJSON();
    return route.fulfill({
      json: { member: false, boardId: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' },
    });
  });
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({
      json: { ...snapshot(), id: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace', expiresAt: null },
    }),
  );
  const asked: string[] = [];
  await page.route('**/api/shared/assets/*/**', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(FIXTURE) });
  });

  await page.goto('/s#share-token');
  await expect(page.getByText('Shared by Ada Lovelace · view only')).toBeVisible();
  expect(page.url()).not.toContain('share-token');
  expect(redeemedWith).toEqual({ token: 'share-token' });
  // Not the application: no navigation, no library, no edit tools.
  await expect(page.getByRole('link', { name: 'Library' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(page.getByTestId('canvas-stats')).toContainText('1 items');
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked.every((p) => p.startsWith('/api/shared/assets/'))).toBe(true);
});

test('a share-link viewer shows no participant tiles, whatever its socket says', async ({
  page,
}) => {
  await page.route('**/api/shared/session', (route) =>
    route.fulfill({
      json: { member: false, boardId: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' },
    }),
  );
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({
      json: { ...snapshot(), id: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace', expiresAt: null },
    }),
  );
  await page.route('**/api/shared/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(FIXTURE) }),
  );
  // The server never sends a viewer presence (ADR-0026; server/tests/agent.rs).
  // Even if it did, the viewer would draw no tile, cursor label or focus label.
  let heard = 0;
  await page.routeWebSocket('**/ws/shared', (ws) => {
    ws.onMessage(() => {
      heard += 1;
      const agent = '01a01640-6b72-7d60-968b-88be186f3500';
      ws.send(JSON.stringify({ t: 'welcome', actorId: 'v', revision: 1, actors: [] }));
      ws.send(
        JSON.stringify({
          t: 'presence',
          joined: [
            { actorId: 'ada', displayName: 'Ada', colourIndex: 1 },
            { actorId: agent, displayName: 'Claude', colourIndex: 2, kind: 'agent', person: 'Ada' },
          ],
        }),
      );
      ws.send(JSON.stringify({ t: 'cursor', actorId: 'ada', x: 10, y: 10 }));
    });
  });

  await page.goto('/s#share-token');
  await expect(page.getByTestId('canvas-stats')).toContainText('1 items');
  await expect.poll(() => heard).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('presence-roster')).toHaveCount(0);
  await expect(page.getByTestId('remote-cursor-tile')).toHaveCount(0);
  await expect(page.getByTestId('agent-focus-label')).toHaveCount(0);
});

test('a locked share link asks for its passphrase and shows nothing until then', async ({
  page,
}) => {
  await page.route('**/api/shared/session', (route) => {
    const body = route.request().postDataJSON() as { passphrase?: string };
    if (body.passphrase === 'open sesame') {
      return route.fulfill({
        json: { member: false, boardId: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' },
      });
    }
    return route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      json: {
        status: 401,
        detail: body.passphrase ? 'that passphrase is not right' : 'this link needs a passphrase',
        passphraseRequired: true,
      },
    });
  });
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({ json: { ...snapshot(), id: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' } }),
  );
  await page.route('**/api/shared/assets/*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(FIXTURE) }),
  );

  await page.goto('/s#locked-token');
  await expect(page.getByRole('heading', { name: 'This board needs a passphrase' })).toBeVisible();
  await expect(page.getByText('Refs')).toBeHidden();
  await page.getByLabel('Passphrase').fill('guess');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByLabel('Passphrase').fill('open sesame');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('Shared by Ada Lovelace · view only')).toBeVisible();
});

test('a revoked share link says so', async ({ page }) => {
  await page.route('**/api/shared/session', (route) =>
    route.fulfill({
      status: 410,
      contentType: 'application/problem+json',
      json: { status: 410, detail: 'this link is no longer active', code: 'revoked' },
    }),
  );
  await page.goto('/s#gone');
  await expect(page.getByRole('alert')).toContainText('no longer active');
});

test('a share link shows the board’s links and their hover, and offers no way to change them', async ({
  page,
}) => {
  const NOTE = '01a01640-6b72-7d60-968b-88be186f7101';
  const FLOW = '01a01640-6b72-7d60-968b-88be186f7102';
  const LINK = '01a01640-6b72-7d60-968b-88be186f7103';
  await page.route('**/api/shared/session', (route) =>
    route.fulfill({
      json: { member: false, boardId: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' },
    }),
  );
  const box = (id: string, x: number, content: unknown) => ({
    id,
    transform: { x, y: 0, width: 220, height: 100, rotation: 0 },
    z: 1,
    revision: 0,
    content,
  });
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          box(NOTE, -200, { kind: 'note', source: '### Overview' }),
          box(FLOW, 150, {
            kind: 'diagram',
            lang: 'mermaid',
            source: 'flowchart LR\n  API --> Pay',
          }),
        ],
        groups: [],
        links: [
          {
            id: LINK,
            from: { itemId: NOTE, element: null },
            to: { itemId: FLOW, element: 'Pay' },
            linkType: 'describes',
          },
        ],
        id: BOARD,
        title: 'Refs',
        sharedBy: 'Ada Lovelace',
        expiresAt: null,
      },
    }),
  );
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(new URL(r.url()).pathname);
  });

  await page.goto('/s#share-token');
  await expect(page.getByText('Shared by Ada Lovelace · view only')).toBeVisible();
  type Hook = {
    links(): { from: { x: number; y: number }; to: { x: number; y: number } }[];
    linkUi(): { hovered: string | null; selected: string | null };
  };
  const links = () =>
    page.evaluate(() => (window as unknown as { __objects?: Hook }).__objects?.links() ?? []);
  await expect.poll(async () => (await links()).length, { timeout: 20_000 }).toBe(1);

  const canvas = await page.locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('no canvas');
  const c = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const [line] = await links();
  if (!line) throw new Error('no line');
  await page.mouse.move(c.x + (line.from.x + line.to.x) / 2, c.y + (line.from.y + line.to.y) / 2);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __objects: Hook }).__objects.linkUi().hovered),
    )
    .toBe(LINK);

  // No gesture changes anything: Alt-drag, a click and Delete leave the board as it was.
  await page.keyboard.down('Alt');
  await page.mouse.move(c.x - 200, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 150, c.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.click(c.x + (line.from.x + line.to.x) / 2, c.y + (line.from.y + line.to.y) / 2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  expect(await links()).toHaveLength(1);
  expect(writes.filter((p) => p !== '/api/shared/session')).toEqual([]);
});

test('a share-link viewer sees a status chip and cannot change it', async ({ page }) => {
  const NOTE = '01a01640-6b72-7d60-968b-88be186f7111';
  await page.route('**/api/shared/session', (route) =>
    route.fulfill({
      json: { member: false, boardId: BOARD, title: 'Refs', sharedBy: 'Ada Lovelace' },
    }),
  );
  await page.route('**/api/shared/board', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        items: [
          {
            id: NOTE,
            transform: { x: 0, y: 0, width: 320, height: 120, rotation: 0 },
            z: 1,
            revision: 0,
            content: { kind: 'note', source: '# ADR-6\n\nStatus: Proposed' },
          },
        ],
        groups: [],
        links: [],
        id: BOARD,
        title: 'Refs',
        sharedBy: 'Ada Lovelace',
        expiresAt: null,
      },
    }),
  );
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(new URL(r.url()).pathname);
  });
  await page.goto('/s#share-token');
  await expect(page.getByText('Shared by Ada Lovelace · view only')).toBeVisible();
  type Rect = { x: number; y: number; width: number; height: number };
  type Hook = {
    layout(id: string): unknown;
    search(id: string, q: string): { text: string } | undefined;
  };
  const layout = (await (
    await page.waitForFunction(
      (i) => (window as unknown as { __objects?: Hook }).__objects?.layout(i),
      NOTE,
    )
  ).jsonValue()) as { hits: { kind: string; rect: Rect }[] };
  const drawnText = await page.evaluate(
    (i) => (window as unknown as { __objects: Hook }).__objects.search(i, 'D')?.text,
    NOTE,
  );
  expect(drawnText).toContain('Decision · Proposed');
  const chip = layout.hits.find((h) => h.kind === 'status');
  if (!chip) throw new Error('no chip');
  const canvas = await page.locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('no canvas');
  await page.waitForTimeout(300);
  await page.mouse.click(
    canvas.x + canvas.width / 2 - 160 + chip.rect.x + chip.rect.width / 2,
    canvas.y + canvas.height / 2 - 60 + chip.rect.y + chip.rect.height / 2,
  );
  await page.waitForTimeout(300);
  await expect(page.getByRole('menu', { name: 'Change status' })).toHaveCount(0);
  expect(writes.filter((p) => p !== '/api/shared/session')).toEqual([]);
});
