import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useBoards,
  useCreateBoard,
  useDeleteBoard,
  useDuplicateBoard,
  useRenameBoard,
} from '~/api/boards';
import { useUiStore } from '~/app/ui-store';

export const Route = createFileRoute('/')({ component: BoardsIndex });

/**
 * The boards that exist.
 *
 * Deliberately a list and not a gallery: a board has no thumbnail until
 * something decides which of its images represents it, and inventing one would
 * be a decision made by the interface rather than by the person. That is now a
 * recorded decision rather than a comment — see UX_PRINCIPLES.md. Renaming is
 * inline; there is no dialog, and nothing here is ever saved by hand.
 */
function BoardsIndex() {
  const boards = useBoards();
  const create = useCreateBoard();
  const duplicate = useDuplicateBoard();
  const rename = useRenameBoard();
  const remove = useDeleteBoard();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  // Said until the next board opens, which clears it.
  const notice = useUiStore((s) => s.boardNotice);

  /**
   * Making a board lands you in it.
   *
   * North star 3 says no ceremony between "new board" and the first image, and
   * being returned to a list to click the thing you just made is exactly that
   * ceremony. The same is true of a copy: you duplicated it to work on it.
   */
  const open = (boardId: string) => void navigate({ to: '/boards/$boardId', params: { boardId } });

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <h1 className="mb-4 text-base">Boards</h1>
      {notice && (
        <p className="mb-4 text-ink" role="status" data-testid="board-notice">
          {notice}
        </p>
      )}

      <form
        className="mb-6 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = title.trim();
          if (!name) return;
          create.mutate(name, { onSuccess: open });
          setTitle('');
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New board"
          aria-label="New board name"
          className="min-w-0 flex-1 rounded border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled focus:border-line-strong focus:outline-none"
        />
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="rounded border border-line-strong px-3 py-1 text-ink hover:bg-surface-raised disabled:text-ink-disabled"
        >
          Create
        </button>
      </form>

      {(create.isError || duplicate.isError || rename.isError || remove.isError) && (
        <p className="mb-2 text-ink">
          {(create.error ?? duplicate.error ?? rename.error ?? remove.error)?.message}
        </p>
      )}
      {boards.isError && <p className="text-ink">boards could not be loaded</p>}
      {boards.isPending && <p className="text-ink-dim">loading…</p>}
      {/* Stated plainly. No illustration, no empty-state artwork. */}
      {boards.data?.length === 0 && (
        <p className="text-ink-dim">No boards yet. Create one, then drop images onto it.</p>
      )}

      <ul>
        {boards.data?.map((board) => (
          <li key={board.id} className="group flex items-center gap-2 border-b border-line py-2">
            <Link
              to="/boards/$boardId"
              params={{ boardId: board.id }}
              className="flex-1 truncate text-ink underline-offset-2 hover:underline"
            >
              {board.title}
            </Link>
            <button
              type="button"
              onClick={() => {
                const next = globalThis.prompt('Rename board', board.title)?.trim();
                if (next && next !== board.title) rename.mutate({ id: board.id, title: next });
              }}
              className="text-ink-dim opacity-0 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
            >
              rename
            </button>
            <button
              type="button"
              // The server names the copy, so two rows never carry the same
              // words and there is no dialog asking for a name nobody has
              // decided yet. Rename it once you know what it became.
              onClick={() => duplicate.mutate(board.id, { onSuccess: open })}
              disabled={duplicate.isPending}
              className="text-ink-dim opacity-0 enabled:hover:text-ink disabled:text-ink-disabled group-hover:opacity-100 group-focus-within:opacity-100"
            >
              duplicate
            </button>
            <button
              type="button"
              onClick={() => {
                // A board holds arrangement, not images: deleting one never
                // deletes an asset. Said out loud, because the two are easy to
                // confuse and only one of them is recoverable.
                if (globalThis.confirm(`Delete "${board.title}"? Its images are not deleted.`)) {
                  remove.mutate(board.id);
                }
              }}
              className="text-ink-dim opacity-0 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
            >
              delete
            </button>
          </li>
        ))}
      </ul>

      {/* The bench boards are for measuring the renderer, not for the person. */}
      {import.meta.env.DEV && (
        <p className="mt-6 text-ink-dim text-[11px]">
          Generated boards for measurement:{' '}
          {['smoke', 'small', 'large', 'assets'].map((id, index) => (
            <span key={id}>
              {index > 0 && ' · '}
              <Link
                to="/boards/$boardId"
                params={{ boardId: id }}
                className="underline underline-offset-2"
              >
                {id}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
