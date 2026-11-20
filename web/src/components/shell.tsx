import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useBoards, useRenameBoard } from '~/api/boards';
import {
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useRenameCollection,
} from '~/api/collections';
import { useHealth } from '~/api/health';
import { useSession, useSignOut } from '~/api/session';
import { useUiStore } from '~/app/ui-store';
import { GENERATED_BOARDS } from '~/features/canvas/board-fixture';
import { LibraryPanel } from '~/features/library/library-panel';
import { ConfirmButton } from './confirm-button';
import { Wordmark } from './wordmark';

/**
 * The application shell.
 *
 * Chrome is deliberately thin: a 34px toolbar, a collapsible sidebar and a 22px
 * status strip. Everything else is canvas. See docs/product/UX_PRINCIPLES.md.
 */
export function Shell({ children }: { children: ReactNode }) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  // Lit while an agent works on the open board, as on hover.
  const agentWorking = useUiStore((s) => s.agentWorking);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div className="flex h-full flex-col bg-surface-sunken text-ink">
      <header className="flex h-[34px] shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-pressed={sidebarOpen}
          aria-label="Sidebar"
          title="Sidebar"
          className="flex h-[22px] items-center rounded px-2 text-ink-dim hover:bg-surface-raised hover:text-ink"
        >
          {/* A glyph with a name, like the selection toolbar: "Panel" said nothing about which. */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <rect x="0.5" y="1.5" width="13" height="11" rx="1.5" />
            <path d="M5 1.5v11" />
          </svg>
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <NavLink to="/">Boards</NavLink>
        <NavLink to="/library">Library</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <BoardTitle />
        <SignedInPerson />
        {/*
         * The face's one size (32px: 1.44px dots), drawn as dots snapped to the
         * device pixel grid rather than set as text, which smeared — see
         * wordmark.tsx. Loudness is held down by `ink-dim` and the corner, not by
         * shrinking it.
         */}
        <Wordmark className="text-ink-dim" illuminated="hover" lit={agentWorking} />
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-line bg-surface p-2">
            <Sidebar />
          </aside>
        )}
        <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <StatusBar />
    </div>
  );
}

/**
 * Who you are, and how to stop being them.
 *
 * In the existing 34px toolbar row rather than a bar of its own: the 56-Pixel
 * Rule says a new persistent bar replaces something or floats over the canvas,
 * and "signed in as" is the least urgent thing on screen during canvas work — it
 * has not earned a single pixel of the canvas's height.
 *
 * The name is `ink-dim`, like every other resting control. It is not drawn in
 * the identity face here: that face names the PRODUCT and a person's name where
 * a person is the subject — beside a cursor, on the account screen — and using
 * it for a status readout in the chrome is how a rule becomes a decoration.
 */
function SignedInPerson() {
  const session = useSession();
  const signOut = useSignOut();
  const me = session.data?.user;
  if (!me) return null;

  return (
    <span className="ml-auto flex items-center gap-1">
      <span className="max-w-40 truncate text-ink-dim" data-testid="signed-in-as">
        {me.displayName}
      </span>
      {!session.data?.singleUser && (
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="rounded-sm px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled"
        >
          Sign out
        </button>
      )}
      <span className="mx-1 h-4 w-px bg-line" />
    </span>
  );
}

/**
 * Which board this is, in the toolbar row that already exists.
 *
 * Nothing else on a board said so. In the 34px row rather than a bar of its
 * own, for the same 56-Pixel reason as the person's name. Pressing it renames
 * in place: Enter or leaving the field keeps it, Esc puts it back.
 */
function BoardTitle() {
  const match = useMatchRoute()({ to: '/boards/$boardId' });
  // A generated board is in no list, and must not ask the server for one.
  const boards = useBoards(match !== false && !(match.boardId in GENERATED_BOARDS));
  const rename = useRenameBoard();
  const [editing, setEditing] = useState(false);
  const board = match ? boards.data?.find((b) => b.id === match.boardId) : undefined;
  if (!board) return null;

  if (editing) {
    const done = (input: HTMLInputElement, keep: boolean) => {
      setEditing(false);
      const next = input.value.trim();
      if (keep && next && next !== board.title) rename.mutate({ id: board.id, title: next });
    };
    return (
      <>
        <span className="mx-1 h-4 w-px bg-line" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the person just pressed the title to edit it
          autoFocus
          defaultValue={board.title}
          aria-label="Board title"
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => done(event.currentTarget, true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') done(event.currentTarget, true);
            if (event.key === 'Escape') done(event.currentTarget, false);
          }}
          className="w-64 rounded border border-line-strong bg-surface-raised px-1.5 py-0.5 text-ink focus:outline-none"
        />
      </>
    );
  }

  return (
    <>
      <span className="mx-1 h-4 w-px bg-line" />
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename board"
        className="max-w-80 truncate rounded px-2 py-0.5 text-ink hover:bg-surface-raised"
        data-testid="board-title"
      >
        {board.title}
      </button>
    </>
  );
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="rounded px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
      activeProps={{ className: 'rounded px-2 py-0.5 bg-surface-raised text-ink' }}
      activeOptions={{ exact: to === '/' }}
    >
      {children}
    </Link>
  );
}

/**
 * The collections that exist, and the library filter they set.
 *
 * Creation is one inline field — a collection has a name and nothing else to
 * configure, so a dialog would be a step asking for information it does not
 * need. Rename and delete are the row's own controls rather than a management
 * screen; a collection is a row, and reorganising is meant to cost nothing.
 */
function Sidebar() {
  const collections = useCollections();
  // The library panel is for placing, so it appears where there is something to
  // place onto. Collections stay underneath it everywhere, because they are
  // navigation and the library filter is not.
  const onBoard = useMatchRoute()({ to: '/boards/$boardId' }) !== false;
  const create = useCreateCollection();
  const rename = useRenameCollection();
  const remove = useDeleteCollection();
  const [name, setName] = useState('');
  const navigate = useNavigate();

  return (
    <>
      {onBoard && <LibraryPanel />}

      <nav aria-label="Collections">
        <h2 className="mb-1 text-[11px] uppercase tracking-wide text-ink-dim">Collections</h2>

        <form
          className="mb-2 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            create.mutate(trimmed);
            setName('');
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New collection"
            aria-label="New collection name"
            className="min-w-0 flex-1 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-ink placeholder:text-ink-disabled focus:border-line-strong focus:outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded border border-line px-1.5 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled"
          >
            add
          </button>
        </form>

        {create.isError && <p className="mb-2 text-ink">{create.error.message}</p>}
        {collections.isError && <p className="text-ink">collections could not be loaded</p>}
        {collections.data?.length === 0 && (
          // Stated plainly, with what a collection is — the word does not carry
          // its own meaning here, because it is not a folder.
          <p className="text-ink-dim">
            No collections yet. They are logical, not folders: an image can be in several.
          </p>
        )}

        <ul>
          {collections.data?.map((collection) => (
            <li key={collection.id} className="group flex items-center gap-1 py-0.5">
              <button
                type="button"
                onClick={() =>
                  void navigate({ to: '/library', search: { collection: collection.id } })
                }
                className="min-w-0 flex-1 truncate text-left text-ink-dim hover:text-ink"
              >
                {collection.name}
              </button>
              {/* Live text, so `ink-dim`: `ink-disabled` is for controls that are off. */}
              <span className="shrink-0 tabular-nums text-[11px] text-ink-dim">
                {collection.assetCount}
              </span>
              <button
                type="button"
                aria-label={`Rename ${collection.name}`}
                onClick={() => {
                  const next = globalThis.prompt('Rename collection', collection.name)?.trim();
                  if (next && next !== collection.name) {
                    rename.mutate({ id: collection.id, name: next });
                  }
                }}
                className="shrink-0 text-[11px] text-ink-dim opacity-0 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
              >
                rename
              </button>
              {/*
                Deleting a collection deletes membership, never images. Said
                out loud because the two are easy to confuse and only one of
                them would be unrecoverable.
              */}
              <ConfirmButton
                label={`Delete ${collection.name}`}
                question={`Delete "${collection.name}"? Its images are not deleted.`}
                onConfirm={() => {
                  remove.mutate(collection.id);
                  void navigate({ to: '/library', search: {} });
                }}
                className="shrink-0 text-[11px] text-ink-dim opacity-0 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
              >
                delete
              </ConfirmButton>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function StatusBar() {
  const health = useHealth();
  const uploads = useUiStore((s) => s.uploads);
  const failures = useUiStore((s) => s.uploadFailures);
  const dismissUploadFailures = useUiStore((s) => s.dismissUploadFailures);
  const interchange = useUiStore((s) => s.interchangeNotice);
  const setInterchangeNotice = useUiStore((s) => s.setInterchangeNotice);
  const sync = useUiStore((s) => s.sync);
  const connection = useUiStore((s) => s.connection);
  const outstanding = uploads.queued + uploads.active;

  // Said only when it is not up: a permanent "backend: UP" is a developer readout.
  const backend = health.isPending
    ? null
    : health.isError
      ? 'unreachable'
      : health.data?.status === 'UP'
        ? null
        : (health.data?.status ?? 'unknown');

  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-line bg-surface px-2 text-[11px] text-ink-dim">
      {outstanding > 0 && (
        // Tabular, because this counts down while the user watches and digits
        // that change width make it jitter. See DESIGN_SYSTEM.md.
        <span className="tabular-nums" data-testid="upload-status">
          uploading {outstanding}
        </span>
      )}
      {sync.failing ? (
        // Not a dialog and not a blocked canvas: a five-second server restart
        // must not freeze a board. The queue is ordered and still retrying, so
        // this says what is true and gets out of the way.
        <span className="text-ink" data-testid="sync-status">
          not saved — retrying
        </span>
      ) : (
        sync.pending > 0 && (
          <span className="tabular-nums text-ink-dim" data-testid="sync-status">
            saving {sync.pending}
          </span>
        )
      )}
      {connection === 'offline' && (
        /*
         * The socket is down; persistence is not.
         *
         * Wording matters more than usual here. Durable writes go over REST and
         * are unaffected, so anything implying lost work would be false — and
         * "offline" is exactly that lie, because the board is still saving. What
         * is actually unavailable is other people.
         */
        <span className="text-ink-dim" data-testid="presence-status">
          others not visible — reconnecting
        </span>
      )}
      {failures.length > 0 && (
        // The one thing in the strip that is a control: a reference that did not
        // land must be acknowledged, not faded away.
        <button
          type="button"
          onClick={dismissUploadFailures}
          className="rounded px-2 py-0.5 text-ink hover:bg-surface-raised"
          data-testid="upload-failures"
        >
          {failures.length} upload{failures.length === 1 ? '' : 's'} failed — dismiss
        </button>
      )}
      {interchange && (
        /*
         * What the last drag or copy could not do, beside the upload failures
         * and for the same reason they are here: the platform decided something
         * the person did not ask for, and discovering it by pasting into another
         * application is not discovering it in time. Replaced by the next
         * gesture, dismissed by pressing it, and never faded.
         */
        <button
          type="button"
          onClick={() => setInterchangeNotice(null)}
          className="rounded px-2 py-0.5 text-ink hover:bg-surface-raised"
          data-testid="interchange-notice"
        >
          {interchange} — dismiss
        </button>
      )}
      {backend && (
        <span className="ml-auto text-ink" data-testid="backend-status">
          server {backend}
        </span>
      )}
    </footer>
  );
}
