/**
 * `/s#token`: a board shared read-only with someone outside (ADR-0026).
 *
 * Rendered before the auth gate, so it needs no account and shows none of the
 * application: no library, no sidebar, no edit tools, no names but the person
 * who shared it. The canvas is the real one in read-only mode, live — a
 * member's edit arrives here as it commits.
 */

import { asCanvasId, CanvasDocument } from '@visarium/canvas-core';
import { type FormEvent, useEffect, useState } from 'react';
import { snapshotInto } from '~/api/boards';
import { fetchSharedBoard, type Redeemed, redeemShare } from '~/api/sharing';
import { useUiStore } from '~/app/ui-store';
import { useFragmentSecret } from '~/components/auth-screens';
import { useElementSize } from '~/components/use-element-size';
import { Wordmark } from '~/components/wordmark';
import { serveImagesFromShareLink } from '~/features/canvas/bitmap-cache';
import { CanvasSurface } from '~/features/canvas/canvas-surface';

type View =
  | { readonly kind: 'opening' }
  | { readonly kind: 'locked'; readonly message: string | null }
  | { readonly kind: 'dead'; readonly message: string }
  | {
      readonly kind: 'board';
      readonly doc: CanvasDocument;
      readonly title: string;
      readonly sharedBy: string | null;
      readonly expiresAt: string | null;
    };

const NOT_ACTIVE = 'This link is no longer active. Ask whoever shared it for a new one.';

async function open(): Promise<View> {
  const board = await fetchSharedBoard();
  if (!board) return { kind: 'dead', message: NOT_ACTIVE };
  const doc = new CanvasDocument(asCanvasId(board.id));
  snapshotInto(doc, board);
  return {
    kind: 'board',
    doc,
    title: board.title,
    sharedBy: board.sharedBy ?? null,
    expiresAt: board.expiresAt ?? null,
  };
}

async function after(redeemed: Redeemed): Promise<View> {
  switch (redeemed.kind) {
    case 'member':
      // Someone with an account here gets the board itself, editable.
      globalThis.location.replace(`/boards/${redeemed.boardId}`);
      return { kind: 'opening' };
    case 'locked':
      return { kind: 'locked', message: redeemed.message };
    case 'dead':
      return { kind: 'dead', message: redeemed.message };
    case 'viewer':
      return open();
  }
}

export function SharedBoardPage() {
  const token = useFragmentSecret();
  const [view, setView] = useState<View>({ kind: 'opening' });
  const connection = useUiStore((s) => s.connection);

  useEffect(() => {
    serveImagesFromShareLink();
    // No token: a reload, after the fragment was cleared. The cookie from the
    // first visit is still good if the link is.
    void (token ? redeemShare(token).then(after) : open()).then(setView);
  }, [token]);

  // A revoked link closes the socket. Ask once whether the board is still
  // reachable rather than let the page sit there looking current.
  useEffect(() => {
    if (view.kind !== 'board' || connection !== 'offline') return;
    void fetchSharedBoard().then((board) => {
      if (!board) setView({ kind: 'dead', message: NOT_ACTIVE });
    });
  }, [connection, view.kind]);

  if (view.kind === 'opening') return <div className="h-full bg-surface-sunken" />;
  if (view.kind === 'dead') return <Message>{view.message}</Message>;
  if (view.kind === 'locked') {
    return (
      <Passphrase
        message={view.message}
        submit={(passphrase) =>
          token ? redeemShare(token, passphrase).then(after).then(setView) : Promise.resolve()
        }
      />
    );
  }
  return <Board view={view} />;
}

function Board({ view }: { view: Extract<View, { kind: 'board' }> }) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  return (
    <div className="flex h-full flex-col bg-surface-sunken text-ink">
      <header className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="truncate text-ink">{view.title}</span>
        <span className="truncate text-ink-dim">
          {view.sharedBy ? `Shared by ${view.sharedBy} · ` : ''}view only
          {view.expiresAt ? ` · until ${new Date(view.expiresAt).toLocaleDateString()}` : ''}
        </span>
        <Wordmark className="ml-auto text-ink-dim" />
      </header>
      <div ref={ref} className="relative min-h-0 flex-1" data-testid="shared-board">
        {size.width > 0 && (
          <CanvasSurface
            doc={view.doc}
            width={size.width}
            height={size.height}
            boardId={view.doc.canvasId}
            readOnly
          />
        )}
      </div>
    </div>
  );
}

function Message({ children }: { children: string }) {
  return (
    <div
      className="flex h-full items-center justify-center bg-surface-sunken p-6 text-ink"
      role="alert"
    >
      <div className="max-w-[320px]">
        <Wordmark className="mb-5 text-ink" />
        {children}
      </div>
    </div>
  );
}

/** A locked link: nothing about the board until the passphrase is right. */
function Passphrase({
  message,
  submit,
}: {
  message: string | null;
  submit: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    await submit(passphrase);
    setBusy(false);
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface-sunken px-6">
      <form onSubmit={onSubmit} className="w-full max-w-[320px]">
        <Wordmark className="mb-2 text-ink" />
        <h1 className="mb-6 text-[11px] uppercase tracking-wide text-ink-dim">
          This board needs a passphrase
        </h1>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
            Passphrase
          </span>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="off"
            className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={!passphrase || busy}
          className="mt-4 w-full rounded-sm border border-line-strong px-2 py-1 text-ink hover:bg-surface-raised disabled:text-ink-disabled"
        >
          {busy ? 'Opening…' : 'Open'}
        </button>
        {message && (
          <p className="mt-3 text-ink" role="alert">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}
