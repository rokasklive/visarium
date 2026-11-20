import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import {
  absoluteLink,
  mcpUrl,
  useAccounts,
  useAgentSettings,
  useAgentTokens,
  useChangePassword,
  useCreateAgentToken,
  useCreateInvitation,
  useDeactivateAccount,
  useEditSelf,
  useEndSession,
  useIdentities,
  useInvitations,
  useRevokeAgentToken,
  useRevokeInvitation,
  useSessions,
  useSetAdmin,
  useSetAgentGrant,
  useSetAgentSettings,
  useUnlinkIdentity,
} from '~/api/accounts';
import { copyText, type LocalPort, localPort, setLocalPort } from '~/api/desktop';
import { type Account, providerStart, useSession } from '~/api/session';
import { ConfirmButton } from '~/components/confirm-button';
import { useShortcutLegend } from '~/features/canvas/shortcut-legend';
import { About } from '~/features/settings/about';

export const Route = createFileRoute('/settings')({ component: Settings });

/**
 * Your account, and — if you administer this instance — everyone else's.
 *
 * A document route, so 24px spacing rather than the toolbar's 8px. Three type
 * sizes, one radius, ghost buttons, and no filled control anywhere: this is a
 * settings page, and nothing on it is urgent.
 *
 * There is no picture here and nothing to upload, preview or crop. The display
 * name is the ONLY appearance control a person has, because in this product what
 * a person looks like is their name drawn in the identity face over their
 * presence colour — see docs/product/DESIGN_SYSTEM.md.
 */
function Settings() {
  const session = useSession();
  const me = session.data?.user;

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <h1 className="mb-6 text-base">Settings</h1>
      {me ? <SelfSection me={me} /> : null}
      {me && !session.data?.singleUser ? <SignInMethods /> : null}
      {me && !session.data?.singleUser ? <SessionsSection /> : null}
      {me ? <AgentsSection singleUser={session.data?.singleUser ?? false} /> : null}
      {me?.admin && !session.data?.singleUser ? <AdminSection meId={me.id} /> : null}
      <CanvasSection />
      {me ? <About Heading={SectionHeading} Button={GhostButton} /> : null}
    </div>
  );
}

/** How the canvas looks on this device; kept in this browser, not the account. */
function CanvasSection() {
  const [legend, setLegend] = useShortcutLegend();
  return (
    <section className="mb-6 border-b border-line pb-6">
      <SectionHeading>Canvas</SectionHeading>
      <label className="flex items-center gap-2 text-ink" data-testid="shortcut-legend-setting">
        <input type="checkbox" checked={legend} onChange={(e) => setLegend(e.target.checked)} />
        Show shortcut legend
        <span className="text-ink-dim">(lower-left of the board, on this device)</span>
      </label>
    </section>
  );
}

/** A section heading. 11px uppercase is what makes small text read as a heading. */
function SectionHeading({ children }: { children: string }) {
  return <h2 className="mb-3 text-[11px] uppercase tracking-wide text-ink-dim">{children}</h2>;
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  autoComplete: string;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="w-full max-w-[320px] rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled"
      />
    </label>
  );
}

function GhostButton({
  children,
  disabled,
  onClick,
  type = 'button',
  label,
}: {
  children: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  label?: string;
}) {
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled"
    >
      {children}
    </button>
  );
}

function SelfSection({ me }: { me: Account }) {
  const edit = useEditSelf();
  const changePassword = useChangePassword();
  const session = useSession();
  const identities = useIdentities();
  // An account that signs in only through a provider has no current password
  // to ask for; setting its first one is the same form without that field.
  const hasPassword = identities.data?.hasPassword ?? true;
  const passwords = !session.data?.singleUser && (session.data?.passwordEnabled ?? true);

  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const identityChanged =
    displayName !== (me.displayName ?? '') || username !== (me.username ?? '');

  function saveIdentity(event: FormEvent) {
    event.preventDefault();
    if (!identityChanged || edit.isPending) return;
    edit.mutate({ displayName: displayName.trim(), username: username.trim() });
  }

  function savePassword(event: FormEvent) {
    event.preventDefault();
    if (changePassword.isPending) return;
    changePassword.mutate(hasPassword ? { currentPassword, newPassword } : { newPassword }, {
      onSuccess: () => {
        setCurrentPassword('');
        setNewPassword('');
      },
    });
  }

  return (
    <>
      <section className="mb-6 border-b border-line pb-6">
        <SectionHeading>You</SectionHeading>
        <form onSubmit={saveIdentity}>
          <TextField
            label="Display name"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="name"
          />
          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
          />
          <GhostButton type="submit" disabled={!identityChanged || edit.isPending}>
            Save
          </GhostButton>
          {edit.isError && (
            <p className="mt-2 text-ink" role="alert">
              {edit.error.message}
            </p>
          )}
        </form>
        {/* Said out loud, because its absence is a decision rather than a gap. */}
        <p className="mt-3 text-[11px] text-ink-dim">
          Your display name is how you appear to everyone else — beside your cursor on a shared
          board. There is no picture; a name is the whole of it.
        </p>
      </section>

      {passwords && (
        <section className="mb-6 border-b border-line pb-6">
          <SectionHeading>Password</SectionHeading>
          <form onSubmit={savePassword}>
            {hasPassword && (
              <TextField
                label="Current password"
                value={currentPassword}
                onChange={setCurrentPassword}
                type="password"
                autoComplete="current-password"
              />
            )}
            <TextField
              label="New password"
              value={newPassword}
              onChange={setNewPassword}
              type="password"
              autoComplete="new-password"
            />
            <GhostButton
              type="submit"
              disabled={
                (hasPassword && !currentPassword) || !newPassword || changePassword.isPending
              }
            >
              {hasPassword ? 'Change password' : 'Set a password'}
            </GhostButton>
            {changePassword.isError && (
              <p className="mt-2 text-ink" role="alert">
                {changePassword.error.message}
              </p>
            )}
            {changePassword.isSuccess && (
              <p className="mt-2 text-ink-dim">Changed. Your other sessions were signed out.</p>
            )}
          </form>
          <p className="mt-3 text-[11px] text-ink-dim">
            At least 12 characters. No expiry and no composition rules — length is the only one that
            helps.
          </p>
        </section>
      )}
    </>
  );
}

/**
 * How you get in: a password, and any providers linked to this account.
 * Linking is a trip through the provider and back; unlinking the last way in
 * is refused by the server, with the reason.
 */
function SignInMethods() {
  const session = useSession();
  const identities = useIdentities();
  const unlink = useUnlinkIdentity();
  const providers = session.data?.providers ?? [];
  const linked = new Set(identities.data?.identities.map((i) => i.provider));
  if (providers.length === 0 && (identities.data?.identities.length ?? 0) === 0) return null;

  return (
    <section className="mb-6 border-b border-line pb-6">
      <SectionHeading>Sign-in methods</SectionHeading>
      <ul className="mb-3">
        {identities.data?.identities.map((i) => (
          <li key={i.provider} className="flex items-center gap-2 border-b border-line py-1.5">
            <span className="min-w-0 flex-1 truncate text-ink">
              {i.name}
              {i.email && <span className="ml-2 text-ink-dim">{i.email}</span>}
            </span>
            <GhostButton
              label={`Remove ${i.name} sign-in`}
              disabled={unlink.isPending}
              onClick={() => unlink.mutate(i.provider)}
            >
              remove
            </GhostButton>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {providers
          .filter((p) => !linked.has(p.id))
          .map((p) => (
            <a
              key={p.id}
              href={providerStart(p.id, 'link', '/settings')}
              className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink"
            >
              Add {p.name} sign-in
            </a>
          ))}
      </div>
      {unlink.isError && (
        <p className="mt-2 text-ink" role="alert">
          {unlink.error.message}
        </p>
      )}
    </section>
  );
}

/** Every browser and device signed in as you, and how to end any of them. */
function SessionsSection() {
  const sessions = useSessions();
  const end = useEndSession();
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  return (
    <section className="mb-6 border-b border-line pb-6">
      <SectionHeading>Where you are signed in</SectionHeading>
      {sessions.isError && <p className="mb-3 text-ink">sessions could not be loaded</p>}
      <ul className="mb-3">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-2 border-b border-line py-1.5">
            <span className="min-w-0 flex-1 truncate text-ink">
              {s.label || (s.kind === 'device' ? 'A device' : 'A browser')}
              <span className="ml-2 text-ink-dim">
                {s.current ? 'this one' : `last used ${new Date(s.lastSeenAt).toLocaleString()}`}
              </span>
            </span>
            {!s.current && (
              <GhostButton
                label={`Sign out ${s.label ?? 'this session'}`}
                disabled={end.isPending}
                onClick={() => end.mutate(s.id)}
              >
                sign out
              </GhostButton>
            )}
          </li>
        ))}
      </ul>
      <GhostButton disabled={others === 0 || end.isPending} onClick={() => end.mutate('others')}>
        Sign out everywhere else
      </GhostButton>
      {end.isError && (
        <p className="mt-2 text-ink" role="alert">
          {end.error.message}
        </p>
      )}
    </section>
  );
}

/**
 * AI agents working on your boards (ADR-0031): the tokens they connect with,
 * and the line that connects one. A token is shown once, when it is made —
 * copied then or made again — and acts with exactly your access.
 *
 * Everything meant to be copied sits in a read-only field with its own copy
 * button: the interface's text does not select (app.css), fields do.
 */
function AgentsSection({ singleUser }: { singleUser: boolean }) {
  const tokens = useAgentTokens(!singleUser);
  const create = useCreateAgentToken();
  const revoke = useRevokeAgentToken();
  const grant = useSetAgentGrant();
  const local = useAgentSettings(singleUser);
  const setLocal = useSetAgentSettings();
  const [label, setLabel] = useState('');
  const made = create.data;
  const url = mcpUrl();
  const secret = made?.token ?? '<token>';
  const claude = singleUser
    ? `claude mcp add --transport http visarium ${url}`
    : `claude mcp add --transport http visarium ${url} --header "Authorization: Bearer ${secret}"`;
  const generic = JSON.stringify(
    {
      mcpServers: {
        visarium: singleUser
          ? { type: 'http', url }
          : { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } },
      },
    },
    null,
    2,
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(label.trim() || 'An agent', { onSuccess: () => setLabel('') });
  }

  return (
    <section className="mb-6 border-b border-line pb-6" data-testid="agents-section">
      <SectionHeading>Agents</SectionHeading>
      <p className="mb-3 text-ink-dim">
        An AI agent can read and change your boards through Visarium&apos;s MCP endpoint, as you,
        and its changes are marked as the agent&apos;s.
        {singleUser ? ' On this machine it needs no token.' : ' Each agent gets its own token.'}
      </p>
      {singleUser && <LocalPortControl />}
      {singleUser && (
        <label className="mb-3 flex items-center gap-2 text-ink" data-testid="local-manage-boards">
          <input
            type="checkbox"
            checked={local.data?.localAgentsManageBoards ?? false}
            disabled={!local.data || setLocal.isPending}
            onChange={(e) => setLocal.mutate(e.target.checked)}
          />
          Let local agents manage boards
          <span className="text-ink-dim">(create, rename, duplicate; deleting still asks you)</span>
        </label>
      )}
      {!singleUser && (
        <>
          <form onSubmit={submit} className="mb-3 flex items-end gap-2">
            <TextField label="New token for" value={label} onChange={setLabel} autoComplete="off" />
            <span className="mb-3">
              <GhostButton type="submit" disabled={create.isPending}>
                Make token
              </GhostButton>
            </span>
          </form>
          {made && (
            <div
              className="mb-3 rounded-sm border border-line-strong p-2"
              data-testid="agent-token-made"
            >
              <p className="mb-2 text-ink">
                Token for {made.label}. Copy it now: it is not shown again.
              </p>
              <CopyField label="Token" value={made.token} testId="agent-token-secret" />
            </div>
          )}
          {create.isError && (
            <p className="mb-3 text-ink" role="alert">
              {create.error.message}
            </p>
          )}
          {tokens.isError && <p className="mb-3 text-ink">agent tokens could not be loaded</p>}
          <ul className="mb-3">
            {tokens.data?.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 border-b border-line py-1.5"
                data-testid="agent-token"
              >
                <span className="min-w-0 flex-1 truncate text-ink">
                  {t.label || 'An agent'}
                  <span className="ml-2 text-ink-dim">
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                      : 'not used yet'}
                  </span>
                </span>
                <label
                  className="flex items-center gap-1 text-ink-dim"
                  data-testid="agent-token-grant"
                >
                  <input
                    type="checkbox"
                    checked={t.manageBoards}
                    disabled={grant.isPending}
                    onChange={(e) => grant.mutate({ id: t.id, manageBoards: e.target.checked })}
                    aria-label={`Let ${t.label || 'this agent'} manage boards`}
                  />
                  manage boards
                </label>
                <GhostButton
                  label={`Revoke ${t.label ?? 'this token'}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(t.id)}
                >
                  revoke
                </GhostButton>
              </li>
            ))}
          </ul>
        </>
      )}
      <CopyField label="Claude Code" value={claude} testId="agent-snippet-claude" />
      <CopyField label="Any MCP client" value={generic} testId="agent-snippet-json" lines={8} />
    </section>
  );
}

/** A value to copy: a read-only field that selects itself, and a copy button. */
function CopyField({
  label,
  value,
  testId,
  lines,
}: {
  label: string;
  value: string;
  testId: string;
  /** A multi-line value gets a text area this many lines tall. */
  lines?: number;
}) {
  const [copied, setCopied] = useState(false);
  const field =
    'w-full min-w-0 rounded-sm border border-line bg-surface-raised px-2 py-1 font-mono text-[11px] text-ink';
  return (
    <div className="mb-3">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">{label}</span>
      <div className="flex items-start gap-2">
        {lines ? (
          <textarea
            readOnly
            value={value}
            rows={lines}
            aria-label={label}
            data-testid={testId}
            onFocus={(e) => e.target.select()}
            className={`${field} resize-none`}
          />
        ) : (
          <input
            readOnly
            value={value}
            aria-label={label}
            data-testid={testId}
            onFocus={(e) => e.target.select()}
            className={field}
          />
        )}
        <GhostButton
          label={`Copy ${label}`}
          onClick={() => void copyText(value).then((ok) => setCopied(ok))}
        >
          {copied ? 'copied' : 'copy'}
        </GhostButton>
      </div>
    </div>
  );
}

/**
 * The desktop app's local port (desktop/src/local_port.rs): fixed so an agent's
 * address stays put, and moved at once when changed here — the app serves the
 * same library on the new port and brings this window along. Absent in a
 * browser, where there is no app to ask.
 */
function LocalPortControl() {
  const [port, setPort] = useState<LocalPort | undefined>();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  useEffect(() => {
    void localPort().then((p) => {
      setPort(p);
      if (p) setValue(String(p.actual));
    });
  }, []);
  if (!port) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setProblem('a port is a whole number from 1024 to 65535');
      return;
    }
    if (n === port?.actual && n === port?.preferred) return;
    try {
      setMoving(n);
      await setLocalPort(n);
      setPort(await localPort());
    } catch (error) {
      setMoving(null);
      setProblem((error as Error).message);
    }
  }

  return (
    <form onSubmit={save} className="mb-3" data-testid="local-port">
      <div className="flex items-end gap-2">
        <TextField label="Local port" value={value} onChange={setValue} autoComplete="off" />
        <span className="mb-3">
          <GhostButton type="submit" disabled={moving !== null}>
            Save
          </GhostButton>
        </span>
      </div>
      {moving !== null && (
        <p className="mb-2 text-ink" role="status">
          Moving to port {moving}… Agents need the new address below.
        </p>
      )}
      {moving === null && port.preferred !== port.actual && (
        <p className="mb-2 text-ink-dim" role="status">
          Port {port.preferred} was in use when Visarium started, so it is on {port.actual} for now.
        </p>
      )}
      {problem && (
        <p className="mb-2 text-ink" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/**
 * The accounts on this instance.
 *
 * Inline controls on rows, in the shape the collections sidebar already uses —
 * not a management console. An instance has a handful of people on it, and a
 * screen built for hundreds would be a screen built for nobody.
 */
function AdminSection({ meId }: { meId: string | undefined }) {
  const accounts = useAccounts(true);
  const invitations = useInvitations(true);
  const invite = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const setAdmin = useSetAdmin();
  const deactivate = useDeactivateAccount();

  const [note, setNote] = useState('');
  const [asAdmin, setAsAdmin] = useState(false);
  /** The link just made, shown once: the server keeps only its hash. */
  const [made, setMade] = useState<{ link: string; what: string } | null>(null);

  const problem = invite.error ?? revoke.error ?? setAdmin.error ?? deactivate.error;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invite.isPending) return;
    invite.mutate(
      { purpose: 'join', admin: asAdmin, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (inv) => {
          setMade(inv.link ? { link: absoluteLink(inv.link), what: 'Invitation' } : null);
          setNote('');
          setAsAdmin(false);
        },
      },
    );
  }

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
    <section>
      <SectionHeading>Accounts on this instance</SectionHeading>

      {/*
       * Said in words, like every other route's. A list that is empty because it
       * is still loading and a list that is empty because it failed look
       * identical, and one of them invites creating an account that exists.
       */}
      {accounts.isError && <p className="mb-6 text-ink">accounts could not be loaded</p>}
      {accounts.isPending && <p className="mb-6 text-ink-dim">loading…</p>}

      <ul className="mb-6">
        {accounts.data?.map((account) => (
          <li
            key={account.id}
            className="group flex items-center gap-2 border-b border-line py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-ink">
              {account.displayName}
              <span className="ml-2 text-ink-dim">{account.username}</span>
            </span>
            {account.admin && <span className="shrink-0 text-[11px] text-ink-dim">admin</span>}
            {account.deactivatedAt && (
              <span className="shrink-0 text-[11px] text-ink-disabled">deactivated</span>
            )}
            {!account.deactivatedAt && account.id !== meId && (
              <GhostButton
                label={`${account.admin ? 'Remove admin from' : 'Make admin'} ${account.displayName}`}
                disabled={setAdmin.isPending}
                onClick={() =>
                  account.id && setAdmin.mutate({ id: account.id, granted: !account.admin })
                }
              >
                {account.admin ? 'remove admin' : 'make admin'}
              </GhostButton>
            )}
            {!account.deactivatedAt && account.id !== meId && (
              <GhostButton
                label={`Make a password reset link for ${account.displayName}`}
                disabled={invite.isPending}
                onClick={() => resetLink(account)}
              >
                reset link
              </GhostButton>
            )}
            {!account.deactivatedAt && account.id !== meId && (
              // Deactivation signs them out at once and is not deletion:
              // everything they made stays theirs. Said here because the two
              // are easy to confuse.
              <ConfirmButton
                label={`Deactivate ${account.displayName}`}
                disabled={deactivate.isPending}
                question={`Deactivate ${account.displayName}? They are signed out immediately. Everything they made stays theirs.`}
                onConfirm={() => {
                  if (account.id) deactivate.mutate(account.id);
                }}
                className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled"
              >
                deactivate
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>

      <SectionHeading>Invite someone</SectionHeading>
      <form onSubmit={submit}>
        <TextField
          label="Note (who it is for)"
          value={note}
          onChange={setNote}
          autoComplete="off"
        />
        <label className="mb-3 flex items-center gap-2 text-ink-dim">
          <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
          They will administer this instance
        </label>
        <GhostButton type="submit" disabled={invite.isPending}>
          Make an invitation link
        </GhostButton>
      </form>

      {made && (
        <div className="mt-3">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">
            {made.what}
          </span>
          <input
            readOnly
            value={made.link}
            aria-label={made.what}
            onFocus={(e) => e.target.select()}
            className="w-full max-w-[480px] rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink"
          />
          <p className="mt-1 text-[11px] text-ink-dim">Shown once. Copy it and send it to them.</p>
        </div>
      )}

      {problem && (
        <p className="mt-2 text-ink" role="alert">
          {problem.message}
        </p>
      )}

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
                    {inv.admin ? 'admin · ' : ''}until{' '}
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <GhostButton
                  label="Revoke this link"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(inv.id)}
                >
                  revoke
                </GhostButton>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* The honest cost of not depending on SMTP, stated where it applies. */}
      <p className="mt-3 text-[11px] text-ink-dim">
        There is no email on this instance: you send the link yourself. They choose their own
        password, or sign in with a provider. A link works once, for seven days (a reset link, one
        day).
      </p>
    </section>
  );
}
