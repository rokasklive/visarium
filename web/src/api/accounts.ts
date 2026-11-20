import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AgentSettings,
  type AgentToken,
  api,
  type Identities,
  type Invitation,
  type NewAgentToken,
  type Role,
  type SessionView,
  type ShareLink,
  type SignInProviders,
} from '@visarium/api-client';
import { type Account, problemDetail, sessionKey } from './session';

/**
 * Editing an account: your own, and — for staff — everyone else's.
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

// --- staff: moderators and admins -----------------------------------------

/** Mirrors the server's rule: an admin acts on anyone, a moderator on members. */
export function mayActOn(me: Role | undefined, target: Role | undefined): boolean {
  return me === 'admin' || (me === 'moderator' && (target ?? 'member') === 'member');
}

export const isStaff = (role: Role | undefined) => role === 'moderator' || role === 'admin';

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

export function useSetRole() {
  return useAdminMutation(async ({ id, role }: { id: string; role: Role }) => {
    const { data, error } = await api.PUT('/api/accounts/{id}/role', {
      params: { path: { id } },
      body: { role },
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

export function useReactivateAccount() {
  return useAdminMutation(async (id: string) => {
    const { data, error } = await api.DELETE('/api/accounts/{id}/deactivation', {
      params: { path: { id } },
    });
    if (!data) throw new Error(problemDetail(error, 'that account could not be reactivated'));
    return data;
  });
}

// --- every share link on the instance (staff) -----------------------------

const allSharesKey = ['shares', 'all'] as const;

export function useAllShares(enabled: boolean) {
  return useQuery({
    queryKey: allSharesKey,
    enabled,
    queryFn: async (): Promise<ShareLink[]> => {
      const { data, response } = await api.GET('/api/shares');
      if (!data) throw new Error(`could not list the share links: ${response.status}`);
      return data;
    },
  });
}

export function useRevokeAnyShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await api.DELETE('/api/shares/{id}', {
        params: { path: { id } },
      });
      if (!response.ok) throw new Error(problemDetail(error, 'that link could not be revoked'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares'] }),
  });
}

// --- sign-in providers (admins) -------------------------------------------

const providersKey = ['instance-providers'] as const;

export function useProviders(enabled: boolean) {
  return useQuery({
    queryKey: providersKey,
    enabled,
    queryFn: async (): Promise<SignInProviders> => {
      const { data, response } = await api.GET('/api/instance/providers');
      if (!data) throw new Error(`could not list the sign-in providers: ${response.status}`);
      return data;
    },
  });
}

function useProviderMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providersKey });
      // The sign-in screen's buttons come from the session.
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    },
  });
}

export type ProviderEdit = {
  id: string;
  name?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  enabled?: boolean;
};

export function useSaveProvider() {
  return useProviderMutation(async ({ id, ...body }: ProviderEdit) => {
    const { data, error } = await api.PUT('/api/instance/providers/{id}', {
      params: { path: { id } },
      body,
    });
    if (!data) throw new Error(problemDetail(error, 'that provider could not be saved'));
    return data;
  });
}

/** Without `confirm`, the server answers with how many accounts it would strand. */
export class RemovalNeedsConfirm extends Error {}

export function useRemoveProvider() {
  return useProviderMutation(async ({ id, confirm }: { id: string; confirm: boolean }) => {
    const { error, response } = await api.DELETE('/api/instance/providers/{id}', {
      params: { path: { id }, query: confirm ? { confirm: true } : {} },
    });
    if (response.ok) return;
    const message = problemDetail(error, 'that provider could not be removed');
    const asks = (error as { title?: unknown } | undefined)?.title === 'Confirm removal';
    throw asks
      ? new RemovalNeedsConfirm(message.replace(/ Send confirm=true.*$/, ''))
      : new Error(message);
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

// --- agents (ADR-0031) ----------------------------------------------------

const agentTokensKey = ['agent-tokens'] as const;

export function useAgentTokens(enabled: boolean) {
  return useQuery({
    queryKey: agentTokensKey,
    enabled,
    queryFn: async (): Promise<AgentToken[]> => {
      const { data, response } = await api.GET('/api/agent-tokens');
      if (!data) throw new Error(`could not list your agent tokens: ${response.status}`);
      return data;
    },
  });
}

/** Mints a token. The secret is in this result and nowhere else, ever. */
export function useCreateAgentToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (label: string): Promise<NewAgentToken> => {
      const { data, error, response } = await api.POST('/api/agent-tokens', { body: { label } });
      if (!data)
        throw new Error(problemDetail(error, `the token could not be made: ${response.status}`));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentTokensKey }),
  });
}

export function useRevokeAgentToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await api.DELETE('/api/agent-tokens/{id}', {
        params: { path: { id } },
      });
      if (!response.ok) throw new Error(problemDetail(error, 'that token could not be revoked'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentTokensKey }),
  });
}

/** Turns a token's *Manage boards* grant on or off. */
export function useSetAgentGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, manageBoards }: { id: string; manageBoards: boolean }) => {
      const { error, response } = await api.PATCH('/api/agent-tokens/{id}', {
        params: { path: { id } },
        body: { manageBoards },
      });
      if (!response.ok) throw new Error(problemDetail(error, 'the grant could not be changed'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentTokensKey }),
  });
}

const agentSettingsKey = ['agent-settings'] as const;

/** The single-user grant for tokenless local agents. */
export function useAgentSettings(enabled: boolean) {
  return useQuery({
    queryKey: agentSettingsKey,
    enabled,
    queryFn: async (): Promise<AgentSettings> => {
      const { data, response } = await api.GET('/api/agent-settings');
      if (!data) throw new Error(`could not read agent settings: ${response.status}`);
      return data;
    },
  });
}

export function useSetAgentSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (localAgentsManageBoards: boolean): Promise<AgentSettings> => {
      const { data, error, response } = await api.PATCH('/api/agent-settings', {
        body: { localAgentsManageBoards },
      });
      if (!data)
        throw new Error(problemDetail(error, `the setting could not be saved: ${response.status}`));
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(agentSettingsKey, data),
  });
}

/** Where an agent connects: this origin's `/mcp`. */
export function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}

// --- invitations (staff) -------------------------------------------------

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
      role?: Role;
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
