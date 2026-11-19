import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@visarium/api-client';
import type { BenchAsset } from '~/features/canvas/board-fixture';

/** What the library grid draws: identity, intrinsic size, and a name to search by. */
export interface LibraryAsset {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType?: string | undefined;
  readonly filename: string;
  /**
   * How many boards currently show it. Zero is the interesting value: an unused
   * asset is exactly what somebody is hunting when they are cleaning up.
   */
  readonly boards: number;
  /** Set only in the deleted view. */
  readonly deletedAt?: string | undefined;
}

/** Most recent, or by name. The cursor carries whichever it was minted for. */
export type LibraryOrder = 'recent' | 'name';

export interface LibraryFilter {
  readonly q?: string | undefined;
  readonly collection?: string | undefined;
  readonly sort?: LibraryOrder | undefined;
  /** The deleted view. One value, one meaning: never both at once. */
  readonly deleted?: boolean | undefined;
}

/**
 * The library, one page at a time.
 *
 * Paging is by cursor rather than page number, because the server pages by
 * keyset: the cursor is the last row of the previous page, so assets uploaded
 * while the user scrolls cannot shift a boundary and show an image twice. The
 * cursor is opaque — it is passed back exactly as received.
 */
export function useLibrary(filter: LibraryFilter) {
  return useInfiniteQuery({
    queryKey: [
      'library',
      filter.q ?? '',
      filter.collection ?? '',
      filter.sort ?? 'recent',
      filter.deleted ?? false,
    ],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { assets: LibraryAsset[]; nextCursor?: string }) => last.nextCursor,
    queryFn: async ({ pageParam }) => {
      const { data, response } = await api.GET('/api/assets', {
        params: {
          query: {
            ...(filter.q ? { q: filter.q } : {}),
            ...(filter.collection ? { collection: filter.collection } : {}),
            ...(filter.sort && filter.sort !== 'recent' ? { sort: filter.sort } : {}),
            ...(filter.deleted ? { deleted: true } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
      });
      if (!data) throw new Error(`could not list the library: ${response.status}`);
      return {
        assets: (data.assets ?? []).flatMap(toLibraryAsset),
        ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
      };
    },
  });
}

/**
 * The schema marks every field optional, though the server always sends them. An asset without an identity or a size cannot be
 * drawn at a known aspect ratio, so it is dropped rather than faked.
 */
function toLibraryAsset(asset: {
  id?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  originalFilename?: string;
  boards?: number;
  deletedAt?: string;
}): LibraryAsset[] {
  if (!asset.id || !asset.width || !asset.height) return [];
  return [
    {
      assetId: asset.id,
      width: asset.width,
      height: asset.height,
      mimeType: asset.mimeType,
      filename: asset.originalFilename ?? 'untitled',
      boards: asset.boards ?? 0,
      ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
    },
  ];
}

/**
 * The assets a paste named by URL.
 *
 * A clipboard cannot carry Visarium's private drag type — a page may only write
 * MIME types the platform accepts — so a copy inside Visarium arrives as a list
 * of content URLs and nothing else. Placing needs an intrinsic size, so the ids
 * are resolved here. One request each, because that is what the metadata
 * endpoint offers and a selection is small; an asset that has since been deleted
 * simply contributes nothing.
 */
export async function assetsById(ids: readonly string[]): Promise<LibraryAsset[]> {
  const found = await Promise.all(
    ids.map(async (id) => {
      const { data } = await api.GET('/api/assets/{id}', { params: { path: { id } } });
      return data ? toLibraryAsset(data) : [];
    }),
  );
  return found.flat();
}

/**
 * The first page of the library, flattened for the benchmark board.
 *
 * Its caller is the memory measurement, which has to build a board out of real
 * assets for the number to mean anything. It wants one page and no paging, so it
 * gets the plain query rather than the infinite one.
 */
export function useRecentAssets(limit: number, enabled: boolean) {
  return useQuery({
    queryKey: ['assets', limit],
    enabled,
    retry: false,
    queryFn: async (): Promise<BenchAsset[]> => {
      const { data, response } = await api.GET('/api/assets', {
        params: { query: { limit } },
      });
      if (!data) throw new Error(`could not list assets: ${response.status}`);
      return (data.assets ?? []).flatMap((asset) =>
        asset.id && asset.width && asset.height
          ? [{ assetId: asset.id, width: asset.width, height: asset.height }]
          : [],
      );
    },
  });
}

/**
 * A board still showing an asset somebody tried to delete.
 *
 * The server sends a bounded list plus the true total, because a problem
 * document is an error and not a report. The interface says "and N more".
 */
export interface BoardUsingAsset {
  readonly id: string;
  readonly title: string;
  readonly items: number;
}

/** Thrown by {@link useDeleteAsset} when the asset is still on a board. */
export class AssetInUseError extends Error {
  constructor(
    readonly boards: readonly BoardUsingAsset[],
    readonly boardCount: number,
  ) {
    super(`this image is still on ${boardCount} board${boardCount === 1 ? '' : 's'}`);
    this.name = 'AssetInUseError';
  }
}

/**
 * Every asset mutation invalidates the library and the collections.
 *
 * Both, for the reason the collection mutations already give: a deletion changes
 * what a collection-filtered page contains AND the count beside that
 * collection's name. Boards are invalidated too, because a cascade removes items
 * from them — a board list showing stale contents after a cascade is the kind of
 * lie this product's sync layer exists to prevent.
 */
function useAssetMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
    },
  });
}

/**
 * The only name an asset has, and therefore the only thing search can match.
 *
 * No board changes: boards reference assets by id, so no revision advances and
 * nobody's open canvas hears anything.
 */
export function useRenameAsset() {
  return useAssetMutation(async ({ assetId, filename }: { assetId: string; filename: string }) => {
    const { response } = await api.PATCH('/api/assets/{id}', {
      params: { path: { id: assetId } },
      body: { filename },
    });
    if (!response.ok) throw new Error(`could not rename the image: ${response.status}`);
  });
}

/**
 * Take an asset out of the library.
 *
 * A `409` is not a failure to report as one: it is the answer, and it carries
 * the boards that still show the asset. The caller turns that into the second,
 * explicit act rather than into an error message.
 */
export function useDeleteAsset() {
  return useAssetMutation(
    async ({ assetId, withItems }: { assetId: string; withItems?: boolean }) => {
      const { response, error } = await api.DELETE('/api/assets/{id}', {
        params: {
          path: { id: assetId },
          ...(withItems ? { query: { withItems: true } } : {}),
        },
      });
      if (response.status === 409) {
        const problem = error as { boards?: BoardUsingAsset[]; boardCount?: number } | undefined;
        throw new AssetInUseError(problem?.boards ?? [], problem?.boardCount ?? 0);
      }
      if (!response.ok) throw new Error(`could not delete the image: ${response.status}`);
    },
  );
}

export function useRestoreAsset() {
  return useAssetMutation(async (assetId: string) => {
    const { response } = await api.POST('/api/assets/{id}/restore', {
      params: { path: { id: assetId } },
    });
    if (!response.ok) throw new Error(`could not restore the image: ${response.status}`);
  });
}

/** The one irreversible act in the product. Admin only; the server enforces it. */
export function usePurgeAsset() {
  return useAssetMutation(async (assetId: string) => {
    const { response } = await api.DELETE('/api/assets/{id}/file', {
      params: { path: { id: assetId } },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? 'only an admin can remove an image permanently'
          : `could not remove the image: ${response.status}`,
      );
    }
  });
}
