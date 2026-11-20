import type { Page } from '@playwright/test';

/**
 * Being signed in, for the specs whose subject is something else.
 *
 * Since M06 the application makes exactly one request before it renders
 * anything — `GET /api/session` — and routes on the answer: setup, sign-in, or
 * the application. Every spec that wants to reach the application therefore has
 * to answer it, in the same way they already stub the boards and assets they
 * need. The real thing is covered by SessionIT and SecurityCoverageIT against
 * PostgreSQL, and by `auth.spec.ts` here for the browser half.
 */
export const SIGNED_IN_USER = {
  id: '01a01640-6b72-7d60-968b-88be186f32aa',
  username: 'ada',
  displayName: 'Ada Lovelace',
  role: 'admin',
  admin: true,
  deactivatedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
};

export async function signedIn(
  page: Page,
  user: Record<string, unknown> = SIGNED_IN_USER,
  extra: Record<string, unknown> = {},
): Promise<void> {
  /*
   * The sidebar, answered as empty.
   *
   * Since M07 the sidebar holds the library panel on a board route, so opening
   * a board asks for collections and a page of the library whether or not the
   * spec's subject is either. Unanswered, those calls 401 — and the client
   * treats ANY 401 as the session ending, so a spec about wheel zoom would
   * find itself looking at the sign-in screen.
   *
   * Registered first, so a spec that stubs these itself still wins: Playwright
   * matches the most recently added route.
   */
  await page.route(
    (url) => url.pathname === '/api/collections',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(
    (url) => url.pathname === '/api/assets',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"assets":[]}' })
        : route.fallback(),
  );

  // The status strip polls this from every route, and it is chrome rather than
  // any spec's subject. Left unanswered it is one more 401 that reads as a
  // session ending — which is also what happens when something else is holding
  // the backend's port in development.
  await page.route(
    (url) => url.pathname === '/api/health',
    (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"up"}' }),
  );

  await page.route('**/api/session', (route) => {
    // DELETE is the sign-out; anything else is the boot question.
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ json: { setupRequired: false, user, ...extra } });
  });
}

/** The sidebar starts collapsed; specs that use it start with it open. */
export async function sidebarOpen(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('visarium.sidebar', 'open'));
}
