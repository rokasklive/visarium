import { createFileRoute } from '@tanstack/react-router';
import type { Role, SignInProvider } from '@visarium/api-client';
import { type FormEvent, useState } from 'react';
import {
  absoluteLink,
  isStaff,
  mayActOn,
  RemovalNeedsConfirm,
  useAccounts,
  useAllShares,
  useCreateInvitation,
  useDeactivateAccount,
  useInvitations,
  useProviders,
  useReactivateAccount,
  useRemoveProvider,
  useRevokeAnyShare,
  useRevokeInvitation,
  useSaveProvider,
  useSaveStorageLimit,
  useSaveVision,
  useSetRole,
  useStorage,
  useTestVision,
  useVision,
} from '~/api/accounts';
import { useBoards } from '~/api/boards';
import { type Account, providerStart, useSession } from '~/api/session';
import { bytesText, storageState } from '~/api/storage';
import { ConfirmButton } from '~/components/confirm-button';
import { CopyField, GhostButton, SectionHeading, TextField } from '~/components/settings-ui';

export const Route = createFileRoute('/instance')({ component: InstanceSettings });

const ROLES: Role[] = ['member', 'moderator', 'admin'];
const ROLE_NAME: Record<Role, string> = {
  member: 'member',
  moderator: 'moderator',
  admin: 'admin',
};
const field =
  'rounded-sm border border-line bg-surface-raised px-2 py-0.5 text-ink disabled:text-ink-disabled';
const confirmClass =
  'rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled';

/**
 * Instance Settings: the people and the setup of a shared instance, for
 * moderators and admins. Laid out like Settings — anchored sections — and kept
 * apart from it so a person's own page stays about them.
 *
 * A section a role cannot use is not drawn, and its endpoint is never asked
 * for: a moderator's browser never requests the providers.
 */
function InstanceSettings() {
  const session = useSession();
  const me = session.data?.user;
  const role = me?.role;
  if (session.isPending) return <p className="p-6 text-ink-dim">loading…</p>;
  if (session.data?.singleUser || !me || !isStaff(role)) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <h1 className="mb-3 text-base">Instance Settings</h1>
        <p className="text-ink-dim" data-testid="instance-not-staff">
          Instance Settings are for this instance&apos;s moderators and admins.
        </p>
      </div>
    );
  }
  const admin = role === 'admin';
  const sections: [id: string, title: string, shown: boolean][] = [
    ['accounts', 'Accounts', true],
    ['invitations', 'Invitations', true],
    ['shares', 'Share links', session.data?.sharingEnabled ?? false],
    ['storage', 'Storage', true],
    ['sign-in', 'Sign-in', admin],
    ['vision', 'Vision model', admin],
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl gap-6 p-6">
      <nav
        aria-label="Instance Settings sections"
        className="sticky top-6 hidden w-32 shrink-0 self-start sm:block"
      >
        <h1 className="mb-3 text-base">Instance</h1>
        <ul>
          {sections
            .filter(([, , shown]) => shown)
            .map(([id, title]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-sm px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
                >
                  {title}
                </a>
              </li>
            ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <h1 className="mb-6 text-base sm:hidden">Instance Settings</h1>
        <AccountsSection me={me} />
        <InvitationsSection me={me} />
        {session.data?.sharingEnabled ? <SharesSection /> : null}
        <StorageSection admin={admin} />
        {admin ? <SignInSection /> : null}
        {admin ? <VisionSection /> : null}
      </div>
    </div>
  );
}

function Problem({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p className="mt-2 text-ink" role="alert">
      {error.message}
    </p>
  ) : null;
}

/** A link the server shows once: it keeps only the hash. */
function MadeLink({ made }: { made: { link: string; what: string } | null }) {
  if (!made) return null;
  return (
    <div className="mt-3">
      <CopyField label={made.what} value={made.link} testId="made-link" />
      <p className="-mt-2 text-[11px] text-ink-dim">Shown once. Copy it and send it to them.</p>
    </div>
  );
}

// --- accounts ---------------------------------------------------------------

function AccountsSection({ me }: { me: Account }) {
  const accounts = useAccounts(true);
  const setRole = useSetRole();
  const deactivate = useDeactivateAccount();
  const reactivate = useReactivateAccount();
  const invite = useCreateInvitation();
  const [made, setMade] = useState<{ link: string; what: string } | null>(null);
  const admin = me.role === 'admin';
  const problem = setRole.error ?? deactivate.error ?? reactivate.error ?? invite.error;

  function resetLink(account: Account) {
    if (!account.id) return;
    invite.mutate(
      { purpose: 'reset', userId: account.id },
      {
        onSuccess: (inv) =>
          setMade(
            inv.link
              ? { link: absoluteLink(inv.link), what: `Reset link for ${account.displayName}` }
              : null,
          ),
      },
    );
  }

  return (
    <section id="accounts" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Accounts on this instance</SectionHeading>
      {accounts.isError && <p className="mb-6 text-ink">accounts could not be loaded</p>}
      {accounts.isPending && <p className="mb-6 text-ink-dim">loading…</p>}
      <ul className="mb-3" data-testid="accounts">
        {accounts.data?.map((account) => {
          const self = account.id === me.id;
          const reach = !self && mayActOn(me.role, account.role);
          return (
            <li key={account.id} className="flex items-center gap-2 border-b border-line py-1.5">
              <span className="min-w-0 flex-1 truncate text-ink">
                {account.displayName}
                <span className="ml-2 text-ink-dim">{account.username}</span>
              </span>
              {account.deactivatedAt && (
                <span className="shrink-0 text-[11px] text-ink-disabled">deactivated</span>
              )}
              {admin && !self ? (
                <select
                  aria-label={`Role of ${account.displayName}`}
                  value={account.role ?? 'member'}
                  disabled={setRole.isPending}
                  onChange={(e) =>
                    account.id && setRole.mutate({ id: account.id, role: e.target.value as Role })
                  }
                  className={field}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAME[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 text-[11px] text-ink-dim">
                  {ROLE_NAME[account.role ?? 'member']}
                </span>
              )}
              {reach && !account.deactivatedAt && (
                <GhostButton
                  label={`Make a password reset link for ${account.displayName}`}
                  disabled={invite.isPending}
                  onClick={() => resetLink(account)}
                >
                  reset link
                </GhostButton>
              )}
              {reach && !account.deactivatedAt && (
                <ConfirmButton
                  label={`Deactivate ${account.displayName}`}
                  disabled={deactivate.isPending}
                  question={`Deactivate ${account.displayName}? They are signed out immediately. Everything they made stays theirs.`}
                  onConfirm={() => account.id && deactivate.mutate(account.id)}
                  className={confirmClass}
                >
                  deactivate
                </ConfirmButton>
              )}
              {reach && account.deactivatedAt && (
                <GhostButton
                  label={`Reactivate ${account.displayName}`}
                  disabled={reactivate.isPending}
                  onClick={() => account.id && reactivate.mutate(account.id)}
                >
                  reactivate
                </GhostButton>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-ink-dim">
        {admin
          ? 'Moderators look after members and their content. Admins also choose roles and how people sign in.'
          : 'As a moderator you can act on members. Admins and other moderators are an admin’s to change.'}
      </p>
      <MadeLink made={made} />
      <Problem error={problem} />
    </section>
  );
}

// --- invitations ------------------------------------------------------------

function InvitationsSection({ me }: { me: Account }) {
  const invitations = useInvitations(true);
  const invite = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const [note, setNote] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [made, setMade] = useState<{ link: string; what: string } | null>(null);
  const offered = ROLES.filter((r) => mayActOn(me.role, r));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invite.isPending) return;
    invite.mutate(
      { purpose: 'join', role, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (inv) => {
          setMade(inv.link ? { link: absoluteLink(inv.link), what: 'Invitation' } : null);
          setNote('');
          setRole('member');
        },
      },
    );
  }

  return (
    <section id="invitations" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Invite someone</SectionHeading>
      <form onSubmit={submit}>
        <TextField
          label="Note (who it is for)"
          value={note}
          onChange={setNote}
          autoComplete="off"
        />
        {offered.length > 1 && (
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
              Role
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className={field}
            >
              {offered.map((r) => (
                <option key={r} value={r}>
                  {ROLE_NAME[r]}
                </option>
              ))}
            </select>
          </label>
        )}
        <GhostButton type="submit" disabled={invite.isPending}>
          Make an invitation link
        </GhostButton>
      </form>
      <MadeLink made={made} />
      <Problem error={invite.error ?? revoke.error} />

      {(invitations.data?.length ?? 0) > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-wide text-ink-dim">
            Waiting to be used
          </h3>
          <ul>
            {invitations.data?.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2 border-b border-line py-1.5">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {inv.purpose === 'reset' ? `Reset for ${inv.username}` : inv.note || 'Invitation'}
                  <span className="ml-2 text-ink-dim">
                    {inv.purpose === 'join' ? `${ROLE_NAME[inv.role]} · ` : ''}until{' '}
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                {(inv.purpose === 'reset' || mayActOn(me.role, inv.role)) && (
                  <GhostButton
                    label="Revoke this link"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(inv.id)}
                  >
                    revoke
                  </GhostButton>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-[11px] text-ink-dim">
        There is no email on this instance: you send the link yourself. They choose their own
        password, or sign in with a provider. A link works once, for seven days (a reset link, one
        day).
      </p>
    </section>
  );
}

// --- share links --------------------------------------------------------------

function SharesSection() {
  const shares = useAllShares(true);
  const boards = useBoards();
  const revoke = useRevokeAnyShare();
  const title = (id: string) => boards.data?.find((b) => b.id === id)?.title ?? 'a board';
  return (
    <section id="shares" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Share links on this instance</SectionHeading>
      {shares.isError && <p className="text-ink">share links could not be loaded</p>}
      {shares.data?.length === 0 && <p className="text-ink-dim">No working share links.</p>}
      <ul>
        {shares.data?.map((link) => (
          <li key={link.id} className="flex items-center gap-2 border-b border-line py-1.5">
            <span className="min-w-0 flex-1 truncate text-ink">
              {link.label || title(link.canvasId)}
              <span className="ml-2 text-ink-dim">
                {title(link.canvasId)} · by {link.createdByName ?? 'someone'}
                {link.expiresAt ? ` · until ${new Date(link.expiresAt).toLocaleDateString()}` : ''}
              </span>
            </span>
            <ConfirmButton
              label={`Revoke the share link ${link.label ?? ''}`.trim()}
              disabled={revoke.isPending}
              question="Revoke this link? Anyone viewing through it loses access at once."
              onConfirm={() => revoke.mutate(link.id)}
              className={confirmClass}
            >
              revoke
            </ConfirmButton>
          </li>
        ))}
      </ul>
      <Problem error={revoke.error} />
    </section>
  );
}

// --- image storage (moderators and admins; admins set the limit) ------------------

/**
 * How full image storage is, so whoever looks after the instance sees it
 * coming rather than hearing about it from a refused upload. No colour: the
 * bar darkens to ink and the words say how urgent it is (DESIGN_SYSTEM.md).
 */
function StorageSection({ admin }: { admin: boolean }) {
  const storage = useStorage();
  const save = useSaveStorageLimit();
  const [limitGb, setLimitGb] = useState<string | null>(null);
  const u = storage.data;
  const state = u ? storageState(u) : null;
  const shownGb = limitGb ?? (u?.limitBytes ? String(u.limitBytes / 1e9) : '');
  const parsed = Number(shownGb.replace(',', '.'));
  const valid = shownGb.trim() !== '' && Number.isFinite(parsed) && parsed >= 0.1;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid) save.mutate(Math.round(parsed * 1e9), { onSuccess: () => setLimitGb(null) });
  }

  return (
    <section
      id="storage"
      className="mb-6 scroll-mt-6 border-b border-line pb-6"
      data-testid="storage-section"
    >
      <SectionHeading>Storage</SectionHeading>
      {storage.isError && <p className="text-ink">storage could not be loaded</p>}
      {u && state && (
        <>
          <meter
            aria-label="Image storage used"
            min={0}
            max={state.of}
            value={Math.min(u.usedBytes, state.of)}
            data-level={state.level}
            title={state.summary}
            className="storage-meter mb-2"
          />
          <p className="tabular-nums text-ink" data-testid="storage-summary">
            {state.summary}
          </p>
          {state.warning && (
            <p className="mt-1 text-ink" role="status" data-testid="storage-warning">
              {state.warning}
            </p>
          )}
          <p className="mt-1 text-[11px] text-ink-dim tabular-nums">
            {u.images.toLocaleString()} image{u.images === 1 ? '' : 's'}
            {u.trashBytes > 0 ? ` · ${bytesText(u.trashBytes)} of it in the trash` : ''}
            {u.diskFreeBytes != null ? ` · ${bytesText(u.diskFreeBytes)} free on the disk` : ''}
          </p>
          <p className="mt-3 mb-3 text-[11px] text-ink-dim">
            Counts original images, the trash included until it is purged. Thumbnails are a cache on
            top, usually a fraction of this. At the limit new images are refused with a message
            saying so, and nothing already stored is touched.
            {u.diskFreeBytes != null
              ? ` Whatever the limit, ${bytesText(u.diskReserveBytes)} of the disk is kept free for the database.`
              : ''}
          </p>
          {admin ? (
            <form onSubmit={submit} className="flex items-end gap-2" data-testid="storage-form">
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
                  Limit (GB)
                </span>
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  inputMode="decimal"
                  value={shownGb}
                  placeholder="no limit"
                  onChange={(e) => setLimitGb(e.target.value)}
                  className="w-28 rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink tabular-nums placeholder:text-ink-disabled"
                />
              </label>
              <GhostButton type="submit" disabled={!valid || save.isPending}>
                Save
              </GhostButton>
              {u.limitBytes != null && (
                <GhostButton
                  disabled={save.isPending}
                  onClick={() => save.mutate(null, { onSuccess: () => setLimitGb(null) })}
                >
                  Remove limit
                </GhostButton>
              )}
            </form>
          ) : (
            <p className="text-[11px] text-ink-dim">An admin sets the limit.</p>
          )}
          <Problem error={save.error} />
        </>
      )}
    </section>
  );
}

// --- the vision model (admins) ----------------------------------------------------

/**
 * One OpenAI-compatible vision model that describes every image, so agents
 * whose model cannot see images still read what they show (image-descriptions).
 * The key is write-only: the page knows only whether one is set.
 */
function VisionSection() {
  const vision = useVision(true);
  const save = useSaveVision();
  const test = useTestVision();
  const v = vision.data;
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState<string | null>(null);
  // Until edited, the fields show what is saved.
  const values = {
    baseUrl: baseUrl ?? v?.baseUrl ?? '',
    model: model ?? v?.model ?? '',
    prompt: prompt ?? v?.prompt ?? '',
  };
  const input = (enabled: boolean) => ({
    baseUrl: values.baseUrl.trim(),
    model: values.model.trim(),
    prompt: values.prompt,
    enabled,
    ...(apiKey ? { apiKey } : {}),
  });
  const ready = values.baseUrl.trim() !== '' && values.model.trim() !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(input(v?.configured ? v.enabled : true), { onSuccess: () => setApiKey('') });
  }

  return (
    <section
      id="vision"
      className="mb-6 scroll-mt-6 border-b border-line pb-6"
      data-testid="vision-section"
    >
      <SectionHeading>Vision model</SectionHeading>
      <p className="mb-3 text-[11px] text-ink-dim">
        A model that can see images writes a short description of every image, with any text in it,
        so agents whose model cannot read pictures still know what they show, and search finds
        images by their content. Any endpoint that speaks the OpenAI chat completions API with
        images works: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, LiteLLM.
      </p>
      <p className="mb-3 text-ink" data-testid="vision-warning">
        While this is on, every image is sent to the endpoint below to be described.
      </p>
      {vision.isError && <p className="text-ink">the vision model could not be loaded</p>}
      {v?.fromEnv ? (
        <p className="mb-3 text-ink-dim" data-testid="vision-from-env">
          Set by <code>VISARIUM_VISION_*</code> on the server: {v.model} at {v.baseUrl}. Change it
          there.
        </p>
      ) : (
        <form onSubmit={submit} data-testid="vision-form">
          <TextField
            label="Base URL (up to /v1)"
            value={values.baseUrl}
            onChange={setBaseUrl}
            autoComplete="off"
          />
          <TextField label="Model" value={values.model} onChange={setModel} autoComplete="off" />
          <TextField
            label={
              v?.hasKey ? 'API key (one is set; leave empty to keep it)' : 'API key (optional)'
            }
            value={apiKey}
            onChange={setApiKey}
            type="password"
            autoComplete="new-password"
          />
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
              Prompt (empty: the default)
            </span>
            <textarea
              value={values.prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={v?.defaultPrompt}
              rows={4}
              className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled"
            />
          </label>
          <div className="flex items-center gap-2">
            <GhostButton type="submit" disabled={!ready || save.isPending}>
              Save
            </GhostButton>
            <GhostButton
              disabled={!ready || test.isPending}
              onClick={() => test.mutate(input(true))}
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </GhostButton>
            {v?.configured && (
              <GhostButton
                label={v.enabled ? 'Turn the vision model off' : 'Turn the vision model on'}
                disabled={save.isPending}
                onClick={() => save.mutate(input(!v.enabled))}
              >
                {v.enabled ? 'turn off' : 'turn on'}
              </GhostButton>
            )}
          </div>
        </form>
      )}
      {test.data && (
        <div className="mt-3 rounded-sm border border-line p-2" data-testid="vision-test-result">
          {test.data.ok ? (
            <>
              <p className="text-ink">The model answered: “{test.data.caption}”</p>
              <p className="mt-1 text-ink-dim">{test.data.description}</p>
            </>
          ) : (
            <p className="text-ink" role="alert">
              The test failed: {test.data.error}
            </p>
          )}
        </div>
      )}
      <Problem error={save.error ?? test.error} />
      {v?.configured && (
        <p className="mt-3 text-[11px] text-ink-dim" data-testid="vision-status">
          {v.enabled ? 'On' : 'Off'} · {v.described} described · {v.waiting} waiting
          {v.failed > 0 ? ` · ${v.failed} given up on` : ''}
        </p>
      )}
      {v?.lastError && (
        <p className="mt-1 text-[11px] text-ink-dim" data-testid="vision-last-error">
          Last error, {new Date(v.lastError.at).toLocaleString()}: {v.lastError.message}
        </p>
      )}
    </section>
  );
}

// --- sign-in providers (admins) --------------------------------------------------

function SignInSection() {
  const providers = useProviders(true);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const publicUrl = providers.data?.publicUrl ?? null;
  return (
    <section id="sign-in" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Sign-in providers</SectionHeading>
      <p className="mb-3 text-[11px] text-ink-dim">
        OpenID Connect providers people can sign in with, next to{' '}
        {providers.data?.passwordEnabled ? 'username and password' : 'no password sign-in'}. Changes
        apply at once. Accounts still come only from invitations.
      </p>
      {providers.isError && <p className="text-ink">providers could not be loaded</p>}
      <ul className="mb-3" data-testid="providers">
        {providers.data?.providers.map((p) =>
          editing === p.id ? (
            <li key={p.id} className="border-b border-line py-2">
              <ProviderForm existing={p} publicUrl={publicUrl} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <ProviderRow key={p.id} provider={p} onEdit={() => setEditing(p.id)} />
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <ProviderForm publicUrl={publicUrl} onDone={() => setEditing(null)} />
      ) : publicUrl ? (
        <GhostButton onClick={() => setEditing('new')}>Add a provider</GhostButton>
      ) : (
        <p className="text-ink-dim">
          Set <code>VISARIUM_PUBLIC_URL</code> on the server first: a provider has to send people
          back to an address this server knows.
        </p>
      )}
    </section>
  );
}

function ProviderRow({ provider: p, onEdit }: { provider: SignInProvider; onEdit: () => void }) {
  const save = useSaveProvider();
  const remove = useRemoveProvider();
  const [asking, setAsking] = useState<string | null>(null);
  const error = remove.error instanceof RemovalNeedsConfirm ? null : (remove.error ?? save.error);

  return (
    <li className="border-b border-line py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ink">
          {p.name}
          <span className="ml-2 text-ink-dim">
            {p.id} · {p.linkedAccounts ?? 0} linked
          </span>
        </span>
        {p.fromEnv ? (
          <span
            className="shrink-0 text-[11px] text-ink-dim"
            title="Set by VISARIUM_OIDC_* on the server"
          >
            set by the environment
          </span>
        ) : (
          <>
            {!p.enabled && <span className="shrink-0 text-[11px] text-ink-disabled">off</span>}
            <GhostButton
              label={`${p.enabled ? 'Turn off' : 'Turn on'} ${p.name}`}
              disabled={save.isPending}
              onClick={() => save.mutate({ id: p.id, enabled: !p.enabled })}
            >
              {p.enabled ? 'turn off' : 'turn on'}
            </GhostButton>
            <GhostButton label={`Edit ${p.name}`} onClick={onEdit}>
              edit
            </GhostButton>
            <GhostButton
              label={`Remove ${p.name}`}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: p.id, confirm: false },
                  { onError: (e) => e instanceof RemovalNeedsConfirm && setAsking(e.message) },
                )
              }
            >
              remove
            </GhostButton>
          </>
        )}
      </div>
      {asking && (
        <div
          className="mt-2 flex items-center gap-2"
          role="alertdialog"
          aria-label="Remove provider"
        >
          <span className="min-w-0 flex-1 text-ink">
            {asking} Their links are kept: adding {p.id} again restores them.
          </span>
          <GhostButton
            label={`Yes, remove ${p.name}`}
            onClick={() =>
              remove.mutate({ id: p.id, confirm: true }, { onSuccess: () => setAsking(null) })
            }
          >
            remove
          </GhostButton>
          <GhostButton onClick={() => setAsking(null)}>cancel</GhostButton>
        </div>
      )}
      <Problem error={error} />
    </li>
  );
}

function ProviderForm({
  existing,
  publicUrl,
  onDone,
}: {
  existing?: SignInProvider;
  publicUrl: string | null;
  onDone: () => void;
}) {
  const save = useSaveProvider();
  const [id, setId] = useState(existing?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [issuer, setIssuer] = useState(existing?.issuer ?? '');
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const google = id === 'google';
  const cleanId = id.trim().toLowerCase();
  const redirect =
    publicUrl && cleanId ? `${publicUrl.replace(/\/$/, '')}/auth/oidc/${cleanId}/callback` : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(
      {
        id: cleanId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(secret ? { clientSecret: secret } : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={submit} data-testid="provider-form" className="mb-3">
      {!existing && (
        <div className="mb-3 flex items-center gap-2">
          <GhostButton
            onClick={() => {
              setId('google');
              setName('Google');
              setIssuer('');
            }}
          >
            Google
          </GhostButton>
          <span className="text-[11px] text-ink-dim">or any OpenID Connect provider</span>
        </div>
      )}
      {!existing && (
        <TextField
          label="Id (in the redirect address; fixed once saved)"
          value={id}
          onChange={setId}
          autoComplete="off"
        />
      )}
      {redirect && (
        <CopyField
          label="Redirect URI to register with the provider"
          value={redirect}
          testId="redirect-uri"
        />
      )}
      {google && !existing && (
        <p className="-mt-2 mb-3 text-[11px] text-ink-dim">
          In the Google Cloud console, create an OAuth client of type “Web application”, add the
          redirect URI above, then paste its client id and secret here.
        </p>
      )}
      <TextField
        label="Name on the sign-in button"
        value={name}
        onChange={setName}
        autoComplete="off"
      />
      {!google && (
        <TextField label="Issuer URL" value={issuer} onChange={setIssuer} autoComplete="off" />
      )}
      <TextField label="Client id" value={clientId} onChange={setClientId} autoComplete="off" />
      <TextField
        label={existing?.hasSecret ? 'Client secret (leave empty to keep it)' : 'Client secret'}
        value={secret}
        onChange={setSecret}
        type="password"
        autoComplete="new-password"
      />
      <div className="flex items-center gap-2">
        <GhostButton type="submit" disabled={save.isPending || !cleanId}>
          {save.isPending ? 'checking the issuer…' : 'Save'}
        </GhostButton>
        <GhostButton onClick={onDone}>cancel</GhostButton>
        {existing?.enabled && (
          <a
            href={providerStart(existing.id, 'link', '/instance')}
            className="text-ink-dim underline hover:text-ink"
          >
            Test sign-in
          </a>
        )}
      </div>
      <Problem error={save.error} />
    </form>
  );
}
