/**
 * Sharing a board read-only with someone outside (ADR-0026).
 *
 * A ghost button floating over the canvas's top-right corner and a panel under
 * it — not a bar: the 56-Pixel Rule says a new persistent control floats over
 * the canvas or replaces something, and nothing here is worth a row of the
 * canvas's height. Absent where sharing is off and in the desktop's local
 * library, which nothing outside the computer can reach.
 */

import { type FormEvent, useState } from 'react';
import { absoluteLink } from '~/api/accounts';
import { useSession } from '~/api/session';
import { useCreateShare, useRevokeShare, useShares } from '~/api/sharing';
import { useUiStore } from '~/app/ui-store';

const EXPIRIES = [
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'Never', days: null },
] as const;

export function ShareButton({ boardId }: { boardId: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const viewers = useUiStore((s) => s.linkViewers);
  if (!session.data?.sharingEnabled) return null;

  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col items-end">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-sm border border-line bg-surface px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
      >
        Share{viewers > 0 ? ` · ${viewers} viewing` : ''}
      </button>
      {open && <SharePanel boardId={boardId} viewers={viewers} />}
    </div>
  );
}

function SharePanel({ boardId, viewers }: { boardId: string; viewers: number }) {
  const shares = useShares(boardId, true);
  const create = useCreateShare(boardId);
  const revoke = useRevokeShare(boardId);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<1 | 7 | 30 | null>(7);
  const [passphrase, setPassphrase] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    setCopied(false);
    create.mutate(
      {
        expiresInDays: days,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(passphrase ? { passphrase } : {}),
      },
      {
        onSuccess: (share) => {
          setMade(share.link ? absoluteLink(share.link) : null);
          setLabel('');
          setPassphrase('');
        },
      },
    );
  }

  async function copy() {
    if (!made) return;
    await navigator.clipboard.writeText(made);
    setCopied(true);
  }

  const problem = create.error ?? revoke.error;

  return (
    <section
      aria-label="Share this board"
      className="mt-1 w-80 rounded-sm border border-line bg-surface p-3 text-[13px]"
    >
      <h2 className="mb-2 text-[11px] uppercase tracking-wide text-ink-dim">Share read-only</h2>
      <form onSubmit={submit}>
        <label className="mb-2 block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. client review"
            className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled"
          />
        </label>
        <fieldset className="mb-2">
          <legend className="mb-1 text-[11px] uppercase tracking-wide text-ink-dim">
            Expires after
          </legend>
          <div className="flex gap-1">
            {EXPIRIES.map((e) => (
              <button
                key={e.label}
                type="button"
                aria-pressed={days === e.days}
                onClick={() => setDays(e.days)}
                className={`rounded-sm border px-2 py-0.5 ${days === e.days ? 'border-line-strong text-ink' : 'border-line text-ink-dim'} hover:bg-surface-raised`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="mb-2 block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
            Passphrase (optional)
          </span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
            className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={create.isPending}
          className="w-full rounded-sm border border-line-strong px-2 py-1 text-ink hover:bg-surface-raised disabled:text-ink-disabled"
        >
          {create.isPending ? 'Making…' : 'Make a link'}
        </button>
      </form>

      {made && (
        <div className="mt-3">
          <input
            readOnly
            value={made}
            aria-label="The new link"
            onFocus={(e) => e.target.select()}
            className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="mt-1 rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {/* Said because it is true: the server keeps only a hash. */}
          <p className="mt-1 text-[11px] text-ink-dim">Shown once. Copy it now.</p>
        </div>
      )}

      {problem && (
        <p className="mt-2 text-ink" role="alert">
          {problem.message}
        </p>
      )}

      <h2 className="mt-4 mb-1 text-[11px] uppercase tracking-wide text-ink-dim">
        Links{viewers > 0 ? ` · ${viewers} viewing now` : ''}
      </h2>
      {shares.isPending && <p className="text-ink-dim">loading…</p>}
      {shares.data?.length === 0 && (
        <p className="text-ink-dim">None. Nobody outside can see this board.</p>
      )}
      <ul>
        {shares.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-2 border-b border-line py-1">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-ink">
                {s.label || `Link of ${new Date(s.createdAt).toLocaleDateString()}`}
              </span>
              <span className="ml-2 text-[11px] text-ink-dim">
                {s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleDateString()}` : 'no expiry'}
                {s.hasPassphrase ? ' · passphrase' : ''}
                {s.createdByName ? ` · ${s.createdByName}` : ''}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Revoke ${s.label || 'this link'}`}
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(s.id)}
              className="shrink-0 rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
            >
              revoke
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-ink-dim">
        Anyone with the link sees this board, live, and the images on it — nothing else in the
        library. Revoking cuts them off at once.
      </p>
    </section>
  );
}
