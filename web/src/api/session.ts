import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type components } from '@visarium/api-client';

/**
 * Who is signed in, and whether this instance has been claimed.
 *
 * One request answers all three states the application can boot into, so there
 * is no intermediate state a route guard has to reason about — see
 * `AuthGate` in app/providers.tsx.
 */
export type Account = components['schemas']['AppUser'];

export interface SessionState {
  readonly setupRequired: boolean;
  readonly user: Account | undefined;
  /**
   * The desktop app's local library (or `make dev`): one implicit account,
   * always signed in. Signing out would strand the person on a sign-in form no
   * password can pass, so the shell offers no Sign out.
   */
  readonly singleUser?: boolean;
  /** False on an instance that signs in through providers only. */
  readonly passwordEnabled: boolean;
  /** "Continue with Google", and any other OpenID Connect provider. */
  readonly providers: readonly Provider[];
  readonly sharingEnabled: boolean;
  /** A demo sandbox (VISARIUM_DEMO): when it is deleted, and what it holds. */
  readonly demo?: DemoPolicy | undefined;
}

export type DemoPolicy = components['schemas']['DemoPolicy'];

export type Provider = components['schemas']['Provider'];

export const sessionKey = ['session'] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    // The answer decides what is rendered at all, so a stale one is not a
    // freshness problem, it is the wrong screen.
    staleTime: 0,
    retry: false,
    queryFn: async (): Promise<SessionState> => {
      const { data, response } = await api.GET('/api/session');
      if (!data) throw new Error(`could not read the session: ${response.status}`);
      return {
        setupRequired: data.setupRequired ?? false,
        user: data.user,
        singleUser: data.singleUser ?? false,
        passwordEnabled: data.passwordEnabled ?? true,
        providers: data.providers ?? [],
        sharingEnabled: data.sharingEnabled ?? false,
        demo: data.demo,
      };
    },
  });
}

/**
 * The message a failed request carries, or a fallback.
 *
 * The server answers RFC 9457, so `detail` is where the useful sentence is —
 * "a password must be at most 72 bytes and this one is 100…" rather than "400".
 * Showing the status code instead would be showing the user our plumbing.
 */
export function problemDetail(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  }
  return fallback;
}

export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentials: { username: string; password: string }): Promise<Account> => {
      const { data, error } = await api.POST('/api/session', { body: credentials });
      if (!data) {
        throw new Error(problemDetail(error, 'that username and password do not match an account'));
      }
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKey }),
  });
}

export function useSetupInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (admin: {
      username: string;
      displayName: string;
      password: string;
    }): Promise<Account> => {
      const { data, error } = await api.POST('/api/setup', { body: admin });
      if (!data) throw new Error(problemDetail(error, 'this instance could not be set up'));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKey }),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api.DELETE('/api/session');
    },
    onSuccess: () => {
      // Written rather than invalidated, so the gate flips straight to the
      // sign-in screen. Invalidating would put the session query back into
      // `isPending` first, which renders the blank ground for as long as the
      // refetch takes — a flash of nothing between two screens.
      queryClient.setQueryData(sessionKey, (old: SessionState | undefined) => ({
        ...(old ?? { passwordEnabled: true, providers: [], sharingEnabled: false }),
        setupRequired: false,
        user: undefined,
      }));
      // Everything else in the cache belonged to the person who just left.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== sessionKey[0],
      });
    },
  });
}

/**
 * Where a provider button goes: a plain navigation, because signing in
 * through a provider is a trip through its pages and back (ADR-0025).
 */
export function providerStart(
  provider: string,
  intent: 'sign-in' | 'link' | 'claim' = 'sign-in',
  returnTo = '/',
): string {
  const query = new URLSearchParams({ intent, return: returnTo });
  return `/auth/oidc/${encodeURIComponent(provider)}/start?${query}`;
}

/** What `/sign-in?error=` codes mean, in words. Unknown codes get the last line. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  'no-account':
    'There is no account here for that sign-in. Ask an admin for an invitation, then use its link.',
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long or was opened in another browser. Try again.',
  refused: 'The provider’s answer could not be verified. Try again.',
  deactivated: 'That account has been deactivated.',
  'linked-elsewhere': 'That sign-in already belongs to another account here.',
  'already-registered': 'That sign-in already has an account here. Sign in instead.',
  'already-claimed': 'This instance has already been set up. Sign in instead.',
  'signed-out': 'You were signed out. Sign in, then try again.',
  'invite-used': 'That invitation has already been used.',
  'invite-expired': 'That invitation has expired. Ask an admin for a new one.',
  'invite-invalid': 'That invitation is not valid. It may have been revoked.',
  'provider-unreachable': 'The sign-in provider could not be reached. Try again shortly.',
  'provider-gone': 'That sign-in provider is no longer available on this instance.',
};

export function signInError(code: string | null): string | null {
  if (!code) return null;
  return SIGN_IN_ERRORS[code] ?? 'Signing in did not work. Try again.';
}
