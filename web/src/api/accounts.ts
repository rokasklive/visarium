import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Identities, type Invitation, type SessionView } from '@visarium/api-client';
import { type Account, problemDetail, sessionKey } from './session';

/**
 * Editing an account: your own, and — for an admin — everyone else's.
 *
 * There is nothing here about a picture, because an account has none. What
 * identifies a person is their display name, and it is set in one text field.
 */
const accountsKey = ['accounts'] as const;

/** Every self-edit changes who the session says you are, so the session is refetched too. */
function useSelfMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      void queryClient.invalidateQueries({ queryKey: accountsKey });
    },
  });
}

export function useEditSelf() {
  return useSelfMutation(async (edit: { displayName?: string; username?: string }) => {
    const { data, error } = await api.PATCH('/api/accounts/me', { body: edit });
    if (!data) throw new Error(problemDetail(error, 'that change could not be saved'));
    return data;
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    // `currentPassword` is absent when setting the first password on an
    // account that so far signs in only through a provider.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: identitiesKey });
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
    mutationFn: async (change: { currentPassword?: string; newPassword: string }) => {
      const { error, response } = await api.PUT('/api/accounts/me/password', { body: change });
      if (!response.ok) throw new Error(problemDetail(error, 'that password could not be changed'));
    },
  });
}

// --- the admin's view -----------------------------------------------------

export function useAccounts(enabled: boolean) {
  return useQuery({
    queryKey: accountsKey,
    enabled,
    queryFn: async (): Promise<Account[]> => {
      const { data, response } = await api.GET('/api/accounts');
      if (!data) throw new Error(`could not list the accounts: ${response.status}`);
      return data;
    },
  });
}

function useAdminMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsKey }),
  });
}

export function useSetAdmin() {
  return useAdminMutation(async ({ id, granted }: { id: string; granted: boolean }) => {
    const { data, error } = await api.PUT('/api/accounts/{id}/admin', {
      params: { path: { id } },
      body: { granted },
    });
    // The last-admin guard answers 409 with a sentence explaining why, and that
    // sentence is the point — a bare refusal on a control that works for every
    // other account reads as a bug.
    if (!data) throw new Error(problemDetail(error, 'that change could not be made'));
    return data;
  });
}

export function useDeactivateAccount() {
  return useAdminMutation(async (id: string) => {
    const { data, error } = await api.POST('/api/accounts/{id}/deactivation', {
      params: { path: { id } },
    });
    if (!data) throw new Error(problemDetail(error, 'that account could not be deactivated'));
    return data;
  });
}

// --- how I sign in --------------------------------------------------------

const identitiesKey = ['identities'] as const;

export function useIdentities() {
  return useQuery({
    queryKey: identitiesKey,
    queryFn: async (): Promise<Identities> => {
      const { data, response } = await api.GET('/api/accounts/me/identities');
      if (!data) throw new Error(`could not list your sign-in methods: ${response.status}`);
      return data;
    },
  });
}

export function useUnlinkIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      const { error, response } = await api.DELETE('/api/accounts/me/identities/{provider}', {
        params: { path: { provider } },
      });
      // The last-way-in guard answers 409 with the reason; that sentence is the point.
      if (!response.ok) throw new Error(problemDetail(error, 'that sign-in could not be removed'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: identitiesKey }),
  });
}

// --- where I am signed in -------------------------------------------------

const sessionsKey = ['sessions'] as const;

export function useSessions() {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: async (): Promise<SessionView[]> => {
      const { data, response } = await api.GET('/api/sessions');
      if (!data) throw new Error(`could not list your sessions: ${response.status}`);
      return data;
    },
  });
}

export function useEndSession() {
  const queryClient = useQueryClient();
  return useMutation({
    /** One session by id, or every session but this one. */
    mutationFn: async (id: string | 'others') => {
      const { error, response } =
        id === 'others'
          ? await api.DELETE('/api/sessions')
          : await api.DELETE('/api/sessions/{id}', { params: { path: { id } } });
      if (!response.ok) throw new Error(problemDetail(error, 'that session could not be ended'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey }),
  });
}

// --- invitations (admins) -------------------------------------------------

const invitationsKey = ['invitations'] as const;

export function useInvitations(enabled: boolean) {
  return useQuery({
    queryKey: invitationsKey,
    enabled,
    queryFn: async (): Promise<Invitation[]> => {
      const { data, response } = await api.GET('/api/invitations');
      if (!data) throw new Error(`could not list the invitations: ${response.status}`);
      return data;
    },
  });
}

export function useCreateInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitation: {
      purpose: 'join' | 'reset';
      admin?: boolean;
      note?: string;
      userId?: string;
    }): Promise<Invitation> => {
      const { data, error } = await api.POST('/api/invitations', { body: invitation });
      if (!data) throw new Error(problemDetail(error, 'that link could not be made'));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey }),
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await api.DELETE('/api/invitations/{id}', {
        params: { path: { id } },
      });
      if (!response.ok)
        throw new Error(problemDetail(error, 'that invitation could not be revoked'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey }),
  });
}

/** `/invite#…` or `/s#…` from the server, as an address someone can open. */
export function absoluteLink(path: string): string {
  return new URL(path, globalThis.location.origin).href;
}
