import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@visarium/api-client';

export interface CollectionSummary {
  readonly id: string;
  readonly name: string;
  readonly assetCount: number;
}

const collectionsKey = ['collections'] as const;

export function useCollections() {
  return useQuery({
    queryKey: collectionsKey,
    queryFn: async (): Promise<CollectionSummary[]> => {
      const { data, response } = await api.GET('/api/collections');
      if (!data) throw new Error(`could not list collections: ${response.status}`);
      // The schema marks every field optional, though the server always sends
      // them. Asserted once here rather than at each use.
      return data.flatMap((collection) =>
        collection.id && collection.name
          ? [{ id: collection.id, name: collection.name, assetCount: collection.assetCount ?? 0 }]
          : [],
      );
    },
  });
}

/**
 * Every collection mutation invalidates the collection list and the library.
 *
 * Both, because the two are coupled in a way that is easy to miss: a membership
 * write changes a collection's count *and* what a collection-filtered library
 * page contains. Invalidating only the one being written leaves the other
 * showing a number or a grid that is quietly wrong.
 */
function useCollectionMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: collectionsKey });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useCreateCollection() {
  return useCollectionMutation(async (name: string) => {
    const { data, response } = await api.POST('/api/collections', { body: { name } });
    if (!data?.id) {
      throw new Error(
        response.status === 409
          ? 'a collection with that name already exists'
          : `could not create the collection: ${response.status}`,
      );
    }
    return data.id;
  });
}

export function useRenameCollection() {
  return useCollectionMutation(async ({ id, name }: { id: string; name: string }) => {
    const { response } = await api.PATCH('/api/collections/{id}', {
      params: { path: { id } },
      body: { name },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 409
          ? 'a collection with that name already exists'
          : `could not rename the collection: ${response.status}`,
      );
    }
  });
}

export function useDeleteCollection() {
  return useCollectionMutation(async (id: string) => {
    const { response } = await api.DELETE('/api/collections/{id}', { params: { path: { id } } });
    if (!response.ok) throw new Error(`could not delete the collection: ${response.status}`);
  });
}

/**
 * Add or remove several assets at once — one request, and it says which.
 *
 * M04 fired one `PUT` per asset in parallel: adding 200 selected images to a
 * collection was 200 round trips and a report of how many failed. "3 of 200
 * assets could not be updated" is a message; the ids that did not apply are a
 * fact the interface can act on.
 *
 * Idempotence is still the database's, so sending the same list twice is not an
 * error — exactly as sending the same id twice never was.
 */
export function useSetMembership() {
  return useCollectionMutation(
    async ({
      collectionId,
      assetIds,
      member,
    }: {
      collectionId: string;
      assetIds: readonly string[];
      member: boolean;
    }) => {
      const request = {
        params: { path: { id: collectionId } },
        body: { assetIds: [...assetIds] },
      };
      const { data, response } = member
        ? await api.PUT('/api/collections/{id}/assets', request)
        : await api.DELETE('/api/collections/{id}/assets', request);

      if (!response.ok) throw new Error(`could not update the collection: ${response.status}`);
      const skipped = data?.skipped ?? [];
      if (skipped.length > 0) {
        throw new Error(
          `${skipped.length} of ${assetIds.length} images no longer exist: ${skipped.join(', ')}`,
        );
      }
    },
  );
}
