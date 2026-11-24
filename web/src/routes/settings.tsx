import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import {
  mcpUrl,
  useAgentSettings,
  useAgentTokens,
  useChangePassword,
  useCreateAgentToken,
  useEditSelf,
  useEndSession,
  useIdentities,
  useOAuthOffered,
  useRevokeAgentToken,
  useSessions,
  useSetAgentGrant,
  useSetAgentSettings,
  useUnlinkIdentity,
} from '~/api/accounts';
import { type LocalPort, localPort, setLocalPort } from '~/api/desktop';
import { type Account, providerStart, useSession } from '~/api/session';
import { setThemeChoice, type ThemeChoice, themeChoice } from '~/app/theme';
import { CopyField, GhostButton, SectionHeading, TextField } from '~/components/settings-ui';
import { useShortcutLegend } from '~/features/canvas/shortcut-legend';
import { About, Diagnostics } from '~/features/settings/about';

export const Route = createFileRoute('/settings')({ component: Settings });

/**
 * Your own account and this device. Everyone else's accounts, and the
 * instance itself, are in Instance Settings (`instance.tsx`), for staff.
 *
 * A document route, so 24px spacing rather than the toolbar's 8px. Three type
 * sizes, one radius, ghost buttons, and no filled control anywhere: this is a
 * settings page, and nothing on it is urgent.
 *
 * There is no picture here and nothing to upload, preview or crop. The display
 * name is the ONLY control over how a person looks to others, because in this
 * product what a person looks like is their name drawn in the identity face over
 * their presence colour — see docs/product/DESIGN_SYSTEM.md. (Appearance below
 * is how Visarium looks to them: light or dark, on this device.)
 */
function Settings() {
  const session = useSession();
  const me = session.data?.user;
  const shared = !session.data?.singleUser;
  // A demo has no Settings (see SettingsLink); a typed /settings goes back to the boards.
  if (session.data?.demo) return <Navigate to="/" replace />;

  const sections: [id: string, title: string, shown: boolean][] = [
    ['profile', 'Profile', !!me],
    ['security', 'Security', !!me && shared],
    ['agents', 'Agents', !!me],
    ['appearance', 'Appearance', true],
    ['canvas', 'Canvas', true],
    ['diagnostics', 'Diagnostics', !!me],
    ['about', 'About', !!me],
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl gap-6 p-6">
      {/* ponytail: in-page anchors, not sub-routes; a route per section when one outgrows the page. */}
      <nav
        aria-label="Settings sections"
        className="sticky top-6 hidden w-32 shrink-0 self-start sm:block"
      >
        <h1 className="mb-3 text-base">Settings</h1>
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
        <h1 className="mb-6 text-base sm:hidden">Settings</h1>
        {me ? <SelfSection me={me} singleUser={!shared} /> : null}
        {me && shared ? (
          <div id="security" className="scroll-mt-6">
            <PasswordSection />
            <SignInMethods />
            <SessionsSection />
          </div>
        ) : null}
        {me ? <AgentsSection singleUser={!shared} /> : null}
        <AppearanceSection />
        <CanvasSection />
        {me?.role && me.role !== 'member' && shared ? (
          <p className="mb-6 border-b border-line pb-6 text-ink-dim">
            Accounts, invitations and sign-in for this instance are in{' '}
            <Link to="/instance" className="text-ink underline">
              Instance Settings
            </Link>
            .
          </p>
        ) : null}
        {me ? (
          <div id="diagnostics" className="scroll-mt-6">
            <Diagnostics Heading={SectionHeading} Button={GhostButton} />
          </div>
        ) : null}
        {me ? (
          <div id="about" className="scroll-mt-6">
            <About Heading={SectionHeading} Button={GhostButton} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const THEME_CHOICES: [choice: ThemeChoice, label: string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/**
 * Light or dark, on this device (appearance/theme).
 *
 * Native radios drawn as a segmented control, so arrow keys move the choice
 * and a screen reader announces a radio group. The chosen segment is marked in
 * ink on the raised step, never the accent: a stored preference is not
 * focused, selected or active in the accent's sense. Focus is the accent ring,
 * drawn on the segment because the radio itself is hidden.
 */
function AppearanceSection() {
  const [choice, setChoice] = useState(themeChoice);
  return (
    <section id="appearance" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Appearance</SectionHeading>
      <fieldset data-testid="theme-setting">
        <legend className="mb-2 text-ink">Theme</legend>
        <div className="inline-flex rounded-sm border border-line p-0.5">
          {THEME_CHOICES.map(([value, label]) => (
            <label
              key={value}
              className={`cursor-pointer rounded-sm px-3 py-0.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-1 ${
                choice === value ? 'bg-surface-raised text-ink' : 'text-ink-dim hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={choice === value}
                onChange={() => {
                  setChoice(value);
                  setThemeChoice(value);
                }}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-ink-dim">
          On this device. System follows your computer's light or dark setting.
        </p>
      </fieldset>
    </section>
  );
}

/** How the canvas looks on this device; kept in this browser, not the account. */
function CanvasSection() {
  const [legend, setLegend] = useShortcutLegend();
  return (
    <section id="canvas" className="mb-6 scroll-mt-6 border-b border-line pb-6">
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
function SelfSection({ me, singleUser }: { me: Account; singleUser: boolean }) {
  const edit = useEditSelf();
  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [username, setUsername] = useState(me.username ?? '');

  const identityChanged =
    displayName !== (me.displayName ?? '') || username !== (me.username ?? '');

  function saveIdentity(event: FormEvent) {
    event.preventDefault();
    if (!identityChanged || edit.isPending) return;
    edit.mutate({
      displayName: displayName.trim(),
      // The desktop's one account is found by its username at every launch;
      // the server refuses a change, so it is never offered.
      ...(singleUser ? {} : { username: username.trim() }),
    });
  }

  return (
    <section id="profile" className="mb-6 scroll-mt-6 border-b border-line pb-6">
      <SectionHeading>Profile</SectionHeading>
      <form onSubmit={saveIdentity}>
        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
        />
        {!singleUser && (
          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
          />
        )}
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
        {singleUser
          ? 'Your display name marks what you changed, beside what your agents changed. There is no picture; a name is the whole of it.'
          : 'Your display name is how you appear to everyone else — beside your cursor on a shared board. There is no picture; a name is the whole of it.'}
      </p>
    </section>
  );
}

function PasswordSection() {
  const changePassword = useChangePassword();
  const session = useSession();
  const identities = useIdentities();
  // An account that signs in only through a provider has no current password
  // to ask for; setting its first one is the same form without that field.
  const hasPassword = identities.data?.hasPassword ?? true;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  if (!(session.data?.passwordEnabled ?? true)) return null;

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
          disabled={(hasPassword && !currentPassword) || !newPassword || changePassword.isPending}
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
  const oauth = useOAuthOffered(!singleUser).data === true;
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
    <section
      id="agents"
      className="mb-6 scroll-mt-6 border-b border-line pb-6"
      data-testid="agents-section"
    >
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
      {oauth && (
        <div className="mb-3" data-testid="agent-connect-by-url">
          <p className="mb-2 text-ink-dim">
            Apps that sign in themselves (Claude, ChatGPT, Cursor, Claude Code) need only this
            address: add it, approve the app in the page that opens, and it appears below.
          </p>
          <CopyField label="Server address" value={url} testId="agent-url" />
        </div>
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
                  {t.connectedBySignIn && (
                    <span className="ml-2 text-ink-dim" data-testid="agent-token-signed-in">
                      connected by sign-in
                    </span>
                  )}
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
