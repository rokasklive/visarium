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
  useSetRole,
} from '~/api/accounts';
import { useBoards } from '~/api/boards';
import { type Account, providerStart, useSession } from '~/api/session';
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
    ['sign-in', 'Sign-in', admin],
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
        {admin ? <SignInSection /> : null}
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
