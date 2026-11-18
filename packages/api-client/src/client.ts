/**
 * The browser's HTTP client.
 *
 * Deliberately thin. `openapi-fetch` is a small wrapper over the platform's
 * `fetch` that reads the generated schema types, so a wrong path or a wrong
 * request body fails at typecheck rather than in production. No axios, no
 * bespoke HTTP layer.
 *
 * Two behaviours are configured here because both are security-relevant and
 * both are easy to forget at the call site:
 *
 *   - `credentials: 'same-origin'` sends the session cookie. Visarium is served
 *     from one origin (see DEPLOYMENT.md), so no CORS and no bearer tokens.
 *   - The server issues a CSRF token as an `XSRF-TOKEN` cookie and expects
 *     it echoed in a header on every state-changing request. A middleware does
 *     that once, rather than every mutation remembering to.
 *   - A `401` from any call means one thing — the session ended — and is handled
 *     once here for the same reason CSRF is: it is easy to forget at a call site
 *     and wrong every time it is forgotten. Handled per query it would surface
 *     as an error inside whichever panel happened to ask first.
 */

import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';

/**
 * The endpoints where a 401 is an ANSWER rather than an expiry.
 *
 * `POST /api/session` answers 401 for a wrong password — routing that to "your
 * session ended" would replace the sign-in form with the sign-in form and throw
 * away the message saying what went wrong. A share link answers 401 for a
 * missing passphrase or a revoked link; that is the viewer's page to explain,
 * and there was never a member session to end.
 */
const AUTHENTICATION_ENDPOINTS = ['/api/session', '/api/setup', '/api/shared'];

export function readCookie(name: string, cookieString: string): string | undefined {
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return request;
    const token = readCookie(CSRF_COOKIE, globalThis.document?.cookie ?? '');
    if (token) request.headers.set(CSRF_HEADER, token);
    return request;
  },
};

type SessionEndedHandler = () => void;

let sessionEnded: SessionEndedHandler | undefined;

/**
 * Called once when any call reports the session is gone.
 *
 * Registered by the application shell, which sends the person to sign in. It is
 * a single handler rather than a subscription list because there is exactly one
 * correct response to being signed out and no second thing that wants to know.
 */
export function onSessionEnded(handler: SessionEndedHandler): void {
  sessionEnded = handler;
}

export const sessionMiddleware: Middleware = {
  onResponse({ request, response }) {
    if (response.status !== 401) return response;
    const path = new URL(request.url).pathname;
    if (AUTHENTICATION_ENDPOINTS.some((endpoint) => path.startsWith(endpoint))) return response;
    sessionEnded?.();
    return response;
  },
};

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * @param baseUrl Same-origin by default. Only set it when a dev server runs on
 *   a different port and the Vite proxy is not in play.
 */
export function createApiClient(baseUrl = '/') {
  const client = createClient<paths>({ baseUrl, credentials: 'same-origin' });
  client.use(csrfMiddleware);
  client.use(sessionMiddleware);
  return client;
}

export const api = createApiClient();
