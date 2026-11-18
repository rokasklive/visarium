import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SharedBoard, type SharedSession, type ShareLink } from '@visarium/api-client';
import type { CanvasDocument } from '@visarium/canvas-core';
import { snapshotInto } from './boards';
import { problemDetail } from './session';

/**
 * Read-only share links (ADR-0026): making them, from a board, and opening
 * one, from outside.
 */

const sharesKey = (boardId: string) => ['shares', boardId] as const;

export function useShares(boardId: string, enabled: boolean) {
  return useQuery({
    queryKey: sharesKey(boardId),
    enabled,
    queryFn: async (): Promise<ShareLink[]> => {
      const { data, response } = await api.GET('/api/boards/{id}/shares', {
        params: { path: { id: boardId } },
      });
      if (!data) throw new Error(`could not list this board's links: ${response.status}`);
      return data;
    },
  });
}

export function useCreateShare(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (share: {
      label?: string;
      expiresInDays: 1 | 7 | 30 | null;
      passphrase?: string;
    }): Promise<ShareLink> => {
      const { data, error } = await api.POST('/api/boards/{id}/shares', {
        params: { path: { id: boardId } },
        body: share,
      });
      if (!data) throw new Error(problemDetail(error, 'that link could not be made'));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharesKey(boardId) }),
  });
}

export function useRevokeShare(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await api.DELETE('/api/shares/{id}', {
        params: { path: { id } },
      });
      if (!response.ok) throw new Error(problemDetail(error, 'that link could not be revoked'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharesKey(boardId) }),
  });
}

// --- the viewer's side ----------------------------------------------------

export type Redeemed =
  | { readonly kind: 'viewer'; readonly session: SharedSession }
  | { readonly kind: 'member'; readonly boardId: string }
  | { readonly kind: 'locked'; readonly message: string | null }
  | { readonly kind: 'dead'; readonly message: string };

/**
 * Trades the token from the link's fragment for a viewer session. A locked
 * link answers with nothing but the fact that it is locked; a wrong passphrase
 * says so.
 */
export async function redeemShare(token: string, passphrase?: string): Promise<Redeemed> {
  const { data, error, response } = await api.POST('/api/shared/session', {
    body: passphrase ? { token, passphrase } : { token },
  });
  if (data) {
    return data.member
      ? { kind: 'member', boardId: data.boardId }
      : { kind: 'viewer', session: data };
  }
  const problem = error as { passphraseRequired?: boolean; detail?: string } | undefined;
  if (response.status === 401 && problem?.passphraseRequired) {
    return { kind: 'locked', message: passphrase ? problemDetail(error, 'that is not it') : null };
  }
  return { kind: 'dead', message: problemDetail(error, 'this link is not active') };
}

export const sharedBoardKey = ['shared-board'] as const;

/** The shared board's own snapshot, with its title and who shared it. */
export async function fetchSharedBoard(): Promise<SharedBoard | null> {
  const { data } = await api.GET('/api/shared/board');
  return data ?? null;
}

/** The resync path for a viewer: the same as the load path, ADR-0011. */
export async function loadSharedSnapshotInto(doc: CanvasDocument): Promise<void> {
  const board = await fetchSharedBoard();
  if (!board) throw new Error('this link is no longer active');
  snapshotInto(doc, board);
}
