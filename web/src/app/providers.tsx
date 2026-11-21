import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { onSessionEnded } from '@visarium/api-client';
import { useEffect } from 'react';
import { sessionKey, useSession } from '~/api/session';
import {
  ConsentScreen,
  DeviceScreen,
  InviteScreen,
  SetupScreen,
  SignInScreen,
} from '~/components/auth-screens';
import { SharedBoardPage } from '~/features/sharing/shared-board';
import { router } from './router';

/**
 * TanStack Query owns SERVER state — boards, assets, collections, uploads.
 * It does not own canvas state; a 100k-item board never enters the query cache.
 * See docs/architecture/CANVAS_CORE.md, "State ownership".
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // The canvas is long-lived and the tab is often left open; refetching on
      // every focus would be noise, not freshness.
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Which of three states this instance is in, decided once before anything else
 * renders.
 *
 * `GET /api/session` answers all three at once, so there is no intermediate
 * state for a route guard to reason about and no flash of application chrome
 * belonging to nobody. The router is not mounted at all until somebody is signed
 * in — which means every route beneath it can assume an account exists rather
 * than each one checking.
 *
 * Two pages sit outside the gate because the link that opens them is the
 * credential, not an account: `/s` (a read-only share, ADR-0026) and `/invite`
 * (joining, or a reset). `/device` sits just inside it: it needs whoever is
 * signed in, and has the sign-in screen in front of it like everything else.
 */
const OUTSIDE_THE_GATE: Record<string, () => React.JSX.Element> = {
  '/s': SharedBoardPage,
  '/invite': InviteScreen,
};

function AuthGate() {
  const Outside = OUTSIDE_THE_GATE[globalThis.location.pathname];
  if (Outside) {
    return <Outside />;
  }
  return <Gate />;
}

function Gate() {
  const session = useSession();
  const queryClient = useQueryClient();

  // A 401 from any call means the session ended. Handled once, here, because
  // there is exactly one correct response to it and every call site that forgot
  // would show a broken panel instead.
  useEffect(() => {
    onSessionEnded(() => {
      queryClient.setQueryData(sessionKey, (old: object | undefined) => ({
        ...old,
        setupRequired: false,
        user: undefined,
      }));
    });
  }, [queryClient]);

  // Deliberately nothing while the first request is in flight. It resolves in
  // one round trip against a local server, and a spinner that appears for 20ms
  // is motion this system does not permit — see DESIGN_SYSTEM.md.
  if (session.isPending) return <div className="h-full bg-surface-sunken" />;

  if (session.isError) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-sunken p-6 text-ink-dim">
        The server is not answering. Check that it is running, then reload.
      </div>
    );
  }

  if (session.data?.setupRequired) return <SetupScreen />;
  if (!session.data?.user) return <SignInScreen />;
  if (globalThis.location.pathname === '/device') return <DeviceScreen />;
  if (globalThis.location.pathname === '/oauth/consent') return <ConsentScreen />;
  // A provider sign-in that succeeded lands wherever it was asked to; one that
  // lands on the sign-in page while signed in has nothing left to show there.
  if (globalThis.location.pathname === '/sign-in') globalThis.history.replaceState(null, '', '/');
  return <RouterProvider router={router} />;
}

export function AppProviders() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}
