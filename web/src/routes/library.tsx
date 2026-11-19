import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  AssetInUseError,
  type BoardUsingAsset,
  type LibraryAsset,
  type LibraryOrder,
  useDeleteAsset,
  useLibrary,
  usePurgeAsset,
  useRenameAsset,
  useRestoreAsset,
} from '~/api/assets';
import { useCollections, useSetMembership } from '~/api/collections';
import { useSession } from '~/api/session';
import { ConfirmButton } from '~/components/confirm-button';
import { LibraryGrid } from '~/features/library/library-grid';

/**
 * The library.
 *
 * The filter lives in the URL rather than in a store: a filtered library is a
 * thing people return to and send each other, the back button is expected to
 * undo a filter, and a reload that silently drops one is a small betrayal. It is
 * also navigation, and the client store holds transient UI state only. The sort
 * and the deleted view are the same kind of thing and join it.
 *
 * This route is where you go to ORGANISE. The sidebar panel on a board route is
 * the same grid at a smaller cell, and it is where you go to work.
 */
export const Route = createFileRoute('/library')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { q?: string; collection?: string; sort?: LibraryOrder; deleted?: boolean } => ({
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
    ...(typeof search.collection === 'string' && search.collection
      ? { collection: search.collection }
      : {}),
    ...(search.sort === 'name' ? { sort: 'name' as const } : {}),
    ...(search.deleted === true || search.deleted === 'true' ? { deleted: true } : {}),
  }),
  component: Library,
});

function Library() {
  const { q, collection, sort, deleted } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const library = useLibrary({ q, collection, sort, deleted });
  const collections = useCollections();
  const setMembership = useSetMembership();
  const rename = useRenameAsset();
  const remove = useDeleteAsset();
  const restore = useRestoreAsset();
  const purge = usePurgeAsset();
  const admin = useSession().data?.user?.admin ?? false;

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Esc clears the selection, which is also what brings the search row back.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(new Set());
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [selected.size]);
  /** The refusal, held until it is acted on or dismissed. See {@link InUseNotice}. */
  const [inUse, setInUse] = useState<{
    asset: LibraryAsset;
    boards: readonly BoardUsingAsset[];
    total: number;
  } | null>(null);

  const assets = library.data?.pages.flatMap((page) => page.assets) ?? [];
  const activeCollection = collections.data?.find((entry) => entry.id === collection);
  const onlySelected =
    selected.size === 1 ? assets.find((asset) => selected.has(asset.assetId)) : undefined;

  const select = (assetId: string, additive: boolean) =>
    setSelected((current) => {
      if (!additive)
        return current.has(assetId) && current.size === 1 ? new Set() : new Set([assetId]);
      const next = new Set(current);
      if (!next.delete(assetId)) next.add(assetId);
      return next;
    });

  /** Rewrite one search key, dropping it when it is the default. */
  const setSearch = (key: 'q' | 'collection' | 'sort' | 'deleted', value: unknown) =>
    void navigate({
      search: (current) => {
        const { [key]: _cleared, ...rest } = current;
        return value ? { ...rest, [key]: value } : rest;
      },
      // Replace, so typing a query does not bury the previous view under one
      // history entry per keystroke.
      replace: key === 'q',
    });

  /**
   * Deleting: attempted, and refused if anything is still showing it.
   *
   * There is no confirmation for an unused image, and that is deliberate: the
   * act is reversible, the library says so, and a dialog asking permission for
   * something a person can undo is a dialog that teaches them to click through
   * dialogs. The interruption is spent where it is worth something — on the
   * cascade, which changes boards they are not looking at.
   */
  const attemptDelete = (asset: LibraryAsset) => {
    setInUse(null);
    remove.mutate(
      { assetId: asset.assetId },
      {
        onSuccess: () => setSelected(new Set()),
        onError: (error) => {
          if (error instanceof AssetInUseError) {
            setInUse({ asset, boards: error.boards, total: error.boardCount });
          }
        },
      },
    );
  };

  const title = deleted ? 'Deleted images' : activeCollection ? activeCollection.name : 'Library';

  return (
    <div className="flex h-full flex-col">
      {/*
       * One row, two contents: the search and sort, or — while something is
       * selected — the selection's acts. The selection used to add a second row,
       * and the grid jumped down under the pointer that had just clicked it.
       * Esc or "clear selection" puts the search back.
       */}
      <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-b border-line px-6 py-2">
        <h1 className="text-base">{title}</h1>

        {selected.size > 0 ? (
          <div className="flex flex-1 flex-wrap items-center gap-2 text-[11px]">
            <span className="mx-1 h-4 w-px bg-line" />
            <span className="text-ink-dim tabular-nums">{selected.size} selected</span>

            {!deleted && collections.data && collections.data.length > 0 && (
              <>
                <label htmlFor="add-to-collection" className="text-ink-dim">
                  add to
                </label>
                <select
                  id="add-to-collection"
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    setMembership.mutate({
                      collectionId: event.target.value,
                      assetIds: [...selected],
                      member: true,
                    });
                  }}
                  className="rounded border border-line bg-surface-raised px-2 py-0.5 text-ink"
                >
                  <option value="">collection…</option>
                  {collections.data.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            {!deleted && activeCollection && (
              <Quiet
                onClick={() =>
                  setMembership.mutate({
                    collectionId: activeCollection.id,
                    assetIds: [...selected],
                    member: false,
                  })
                }
              >
                remove from {activeCollection.name}
              </Quiet>
            )}

            {/*
             * Rename is one image at a time: `original_filename` is the only name
             * an asset has and the only thing search matches, so there is nothing
             * a bulk rename could mean that is not a numbering scheme.
             */}
            {!deleted && onlySelected && (
              <Quiet
                onClick={() => {
                  const next = globalThis.prompt('Rename image', onlySelected.filename)?.trim();
                  if (next && next !== onlySelected.filename) {
                    rename.mutate({ assetId: onlySelected.assetId, filename: next });
                  }
                }}
              >
                rename
              </Quiet>
            )}

            {/*
             * Deleting is one at a time for a reason the refusal makes obvious: it
             * names the boards still showing THIS image, and a bulk refusal would
             * be a list nobody can act on.
             */}
            {!deleted && onlySelected && (
              <Quiet onClick={() => attemptDelete(onlySelected)}>delete</Quiet>
            )}

            {deleted && (
              <Quiet
                onClick={() => {
                  for (const assetId of selected) restore.mutate(assetId);
                  setSelected(new Set());
                }}
              >
                restore
              </Quiet>
            )}

            {/*
             * The only irreversible control in the product, and the only one that
             * is `ink` rather than `ink-dim` at rest. It says what it does in
             * words; there is no icon and no red. See DESIGN_SYSTEM.md.
             */}
            {deleted && admin && onlySelected && (
              <ConfirmButton
                question={
                  `Permanently remove "${onlySelected.filename}"? ` +
                  'This deletes the image file itself. It cannot be undone, and nothing ' +
                  'restores it — not this screen, and not a backup you have not taken.'
                }
                onConfirm={() =>
                  purge.mutate(onlySelected.assetId, { onSuccess: () => setSelected(new Set()) })
                }
                className="rounded px-2 py-0.5 text-ink hover:bg-surface-raised"
              >
                remove permanently
              </ConfirmButton>
            )}

            <Quiet className="ml-auto" onClick={() => setSelected(new Set())}>
              clear selection
            </Quiet>
          </div>
        ) : (
          <>
            <input
              type="search"
              value={q ?? ''}
              onChange={(event) => setSearch('q', event.target.value)}
              placeholder="Search filenames"
              aria-label="Search the library"
              className="ml-auto w-56 rounded border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled focus:border-line-strong focus:outline-none"
            />

            <label
              htmlFor="library-sort"
              className="text-[11px] uppercase tracking-wide text-ink-dim"
            >
              sort
            </label>
            <select
              id="library-sort"
              value={sort ?? 'recent'}
              // Changing the sort starts a new first page, because a cursor minted
              // for one ordering cannot continue another — the server refuses it.
              onChange={(event) => setSearch('sort', event.target.value === 'name' ? 'name' : '')}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-ink-dim"
            >
              <option value="recent">most recent</option>
              <option value="name">name</option>
            </select>

            <button
              type="button"
              aria-pressed={deleted === true}
              onClick={() => {
                setSelected(new Set());
                setInUse(null);
                setSearch('deleted', deleted ? '' : true);
              }}
              className={`rounded px-2 py-1 ${
                deleted
                  ? 'bg-surface-raised text-ink'
                  : 'text-ink-dim hover:bg-surface-raised hover:text-ink'
              }`}
            >
              Deleted
            </button>

            {collection && (
              <button
                type="button"
                onClick={() => setSearch('collection', '')}
                className="rounded px-2 py-1 text-ink-dim hover:bg-surface-raised hover:text-ink"
              >
                clear filter
              </button>
            )}
          </>
        )}
      </div>

      {inUse && (
        <InUseNotice
          {...inUse}
          onCascade={() => {
            remove.mutate(
              { assetId: inUse.asset.assetId, withItems: true },
              {
                onSuccess: () => {
                  setInUse(null);
                  setSelected(new Set());
                },
              },
            );
          }}
          onDismiss={() => setInUse(null)}
        />
      )}

      {(rename.isError || purge.isError || restore.isError || setMembership.isError) && (
        <p className="shrink-0 border-b border-line px-6 py-2 text-ink">
          {(rename.error ?? purge.error ?? restore.error ?? setMembership.error)?.message}
        </p>
      )}

      <div className="min-h-0 flex-1 px-6 py-3">
        {library.isError && <p className="text-ink">the library could not be loaded</p>}
        {library.isPending && <p className="text-ink-dim">loading…</p>}
        {/* Stated in words. No illustration, no empty-state artwork. */}
        {library.isSuccess && assets.length === 0 && (
          <p className="text-ink-dim">
            {deleted
              ? 'Nothing has been deleted. Images you delete wait here until you restore them.'
              : q || collection
                ? 'Nothing matches this filter.'
                : 'No images yet. Drop them onto a board and they arrive here too.'}
          </p>
        )}
        {assets.length > 0 && (
          <LibraryGrid
            assets={assets}
            selected={selected}
            onSelect={select}
            showUsage={!deleted}
            onReachEnd={() => {
              if (library.hasNextPage && !library.isFetchingNextPage) void library.fetchNextPage();
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The refusal, and the second act.
 *
 * Deleting an image that seventeen boards show must not turn seventeen objects
 * into holes without saying so, so the boards are NAMED before anything happens
 * — a person clicking delete in a library is looking at a thumbnail, not at the
 * boards it is on. The confirmation is separate from the refusal because they
 * are different sentences: one says what is true, the other asks for a decision.
 *
 * The words matter more than usual. The asset comes back; the arrangement does
 * not, and saying "you can undo this" would be false about the half people care
 * about.
 */
function InUseNotice({
  asset,
  boards,
  total,
  onCascade,
  onDismiss,
}: {
  asset: LibraryAsset;
  boards: readonly BoardUsingAsset[];
  total: number;
  onCascade: () => void;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="shrink-0 border-b border-line px-6 py-2 text-[11px]">
      <p className="text-ink">
        “{asset.filename}” is still on {total} board{total === 1 ? '' : 's'}.
      </p>
      <ul className="mt-1 mb-2 text-ink-dim">
        {boards.map((board) => (
          <li key={board.id} className="tabular-nums">
            {board.title} · {board.items} item{board.items === 1 ? '' : 's'}
          </li>
        ))}
        {total > boards.length && <li>and {total - boards.length} more</li>}
      </ul>

      {confirming ? (
        <div className="flex items-center gap-2">
          <p className="text-ink">
            This removes it from {total === 1 ? 'that board' : 'those boards'} as well. The image
            can be restored afterwards; where it sat on each board cannot.
          </p>
          <button
            type="button"
            onClick={onCascade}
            className="shrink-0 rounded px-2 py-0.5 text-ink hover:bg-surface-raised"
          >
            remove from {total} board{total === 1 ? '' : 's'} and delete
          </button>
          <Quiet onClick={() => setConfirming(false)}>keep it</Quiet>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Quiet onClick={() => setConfirming(true)}>delete it from those boards too</Quiet>
          <Quiet onClick={onDismiss}>cancel</Quiet>
        </div>
      )}
    </div>
  );
}

/** The resting control everything on this screen is, except the two that are not. */
function Quiet({
  onClick,
  className = '',
  children,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink ${className}`}
    >
      {children}
    </button>
  );
}
