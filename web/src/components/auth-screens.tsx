/**
 * The first two screens anyone ever sees of Visarium.
 *
 * DESIGN_SYSTEM.md already forbids almost everything an onboarding screen
 * usually is — no card, no shadow, no gradient, no illustration, no motion, one
 * radius, one ghost button, and an accent that means *you* and nothing else.
 * That is not a constraint being worked around here; it is the whole design.
 *
 * Two rules are doing the work:
 *
 *   * **The Absent Panel Rule.** A container with nothing to contain does not
 *     exist. The form sits on `surface-sunken` full bleed with no box around it,
 *     which reads as more considered than the same fields inside a rectangle.
 *   * **The accent appears exactly once**, as the focus ring on the field being
 *     typed into. Hence no `focus:outline-none` on these inputs: the global
 *     `:focus-visible` rule in app.css is deliberately left to do its job.
 *
 * The most modern thing a sign-in screen can do is be recognised by the software
 * people actually use to sign in, so these are real `<form>` elements with real
 * `autocomplete` tokens and submit-on-Enter.
 */

import { useQueryClient } from '@tanstack/react-query';
import { api, type InvitationInfo } from '@visarium/api-client';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  type Provider,
  problemDetail,
  providerStart,
  sessionKey,
  signInError,
  useSession,
  useSetupInstance,
  useSignIn,
} from '~/api/session';
import { Wordmark } from './wordmark';

/**
 * The shared frame: one centred column on the bare ground.
 *
 * 320px because two fields and a button need no more, and a wider column would
 * put the label further from the input it names.
 */
function AuthScreen({
  title,
  children,
  illuminatedWordmark = false,
}: {
  title: string;
  children: ReactNode;
  illuminatedWordmark?: boolean;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-sunken px-6">
      <div className="w-full max-w-[320px]">
        <Wordmark className="mb-2 text-ink" illuminated={illuminatedWordmark} />
        <h1 className="mb-6 text-[11px] uppercase tracking-wide text-ink-dim">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** The one control on either screen. Ghost, because nothing here competes with it. */
function SubmitButton({ children, disabled }: { children: ReactNode; disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-4 w-full rounded-sm border border-line-strong px-2 py-1 text-ink hover:bg-surface-raised disabled:text-ink-disabled"
    >
      {children}
    </button>
  );
}

function Field({
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
        className="w-full rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled"
      />
    </label>
  );
}

/**
 * What went wrong, in the server's own words.
 *
 * The server answers RFC 9457 and its `detail` is written to be read — a
 * password refused for length says that bcrypt ignores anything past 72 bytes,
 * rather than "invalid password", which on a length rule reads as arbitrary.
 */
function Problem({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="mt-3 text-ink" role="alert">
      {error.message}
    </p>
  );
}

/**
 * One ghost link per provider: "Continue with Google". A link, not a button,
 * because signing in through a provider is a trip through its pages and back.
 */
function ProviderLinks({
  providers,
  intent,
  returnTo,
}: {
  providers: readonly Provider[];
  intent: 'sign-in' | 'claim';
  returnTo?: string;
}) {
  if (providers.length === 0) return null;
  return (
    <div className="mt-4">
      {providers.map((p) => (
        <a
          key={p.id}
          href={providerStart(p.id, intent, returnTo)}
          className="mt-2 block w-full rounded-sm border border-line-strong px-2 py-1 text-center text-ink hover:bg-surface-raised"
        >
          Continue with {p.name}
        </a>
      ))}
    </div>
  );
}

/** "or", between a password form and the provider links, when there are both. */
function Or() {
  return <p className="mt-4 text-center text-[11px] text-ink-dim">or</p>;
}

/** Where to come back to after signing in: here, unless here is the sign-in page itself. */
function hereForReturn(): string {
  const { pathname, search } = globalThis.location;
  return pathname === '/sign-in' ? '/' : `${pathname}${search}`;
}

/**
 * The desktop app's "Continue with …" buttons send /device?…&provider=id
 * (ADR-0027): a browser not yet signed in — or an instance not yet claimed —
 * goes straight to that provider, and comes back to /device. A provider this
 * server doesn't have gets the ordinary page. True while leaving.
 */
function useStraightToProvider(providers: readonly Provider[], intent: 'sign-in' | 'claim') {
  const [to] = useState(() => {
    const wanted = new URLSearchParams(globalThis.location.search).get('provider');
    return globalThis.location.pathname === '/device' && providers.some((p) => p.id === wanted)
      ? wanted
      : null;
  });
  useEffect(() => {
    if (to) globalThis.location.replace(providerStart(to, intent, hereForReturn()));
  }, [to, intent]);
  return to !== null;
}

/**
 * Claiming a fresh instance.
 *
 * Three fields rather than two: the display name is the whole of how a person
 * appears in this product — it is what sits beside their cursor on a shared
 * board — so asking for it here is cheaper than leaving the first admin
 * labelled with their login name until they find the settings route.
 */
export function SetupScreen() {
  const setup = useSetupInstance();
  const session = useSession();
  const passwordEnabled = session.data?.passwordEnabled ?? true;
  const providers = session.data?.providers ?? [];
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const straightTo = useStraightToProvider(providers, 'claim');

  const ready = displayName.trim() !== '' && username.trim() !== '' && password !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || setup.isPending) return;
    setup.mutate({ displayName: displayName.trim(), username: username.trim(), password });
  }

  if (straightTo) return <div className="h-full bg-surface-sunken" />;

  return (
    <AuthScreen title="Set up this instance" illuminatedWordmark>
      {passwordEnabled && (
        <form onSubmit={submit}>
          <Field
            label="Your name"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="name"
          />
          <Field label="Username" value={username} onChange={setUsername} autoComplete="username" />
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="new-password"
          />
          <SubmitButton disabled={!ready || setup.isPending}>
            {setup.isPending ? 'Creating…' : 'Create the first account'}
          </SubmitButton>
          <Problem error={setup.error} />
        </form>
      )}
      {passwordEnabled && providers.length > 0 && <Or />}
      <ProviderLinks providers={providers} intent="claim" returnTo={hereForReturn()} />

      {/*
       * The access model, said plainly and before anybody is invited — because
       * the risk with "everyone sees everything" is that it is discovered rather
       * than read. DEPLOYMENT.md says it too; this is the copy that reaches the
       * person who actually decides who gets an account.
       */}
      <p className="mt-6 text-[11px] text-ink-dim">
        This is the first account, and it administers the instance. Everyone with an account here
        can see every board and every image; there are no per-board permissions.
      </p>
      <p className="mt-2 text-[11px] text-ink-dim">
        Everyone else joins by an invitation link you make in Settings. A forgotten password is
        reset the same way: a one-time link from an admin.
      </p>
    </AuthScreen>
  );
}

export function SignInScreen() {
  const signIn = useSignIn();
  const session = useSession();
  const passwordEnabled = session.data?.passwordEnabled ?? true;
  const providers = session.data?.providers ?? [];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // A provider sign-in that went wrong lands here with a code in the address.
  const [returned] = useState(() =>
    signInError(new URLSearchParams(globalThis.location.search).get('error')),
  );

  const straightTo = useStraightToProvider(providers, 'sign-in');

  const ready = username.trim() !== '' && password !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || signIn.isPending) return;
    signIn.mutate({ username: username.trim(), password });
  }

  if (straightTo) return <div className="h-full bg-surface-sunken" />;

  return (
    <AuthScreen title="Sign in" illuminatedWordmark>
      {returned && (
        <p className="mb-4 text-ink" role="alert">
          {returned}
        </p>
      )}
      {passwordEnabled && (
        <form onSubmit={submit}>
          <Field label="Username" value={username} onChange={setUsername} autoComplete="username" />
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="current-password"
          />
          <SubmitButton disabled={!ready || signIn.isPending}>
            {signIn.isPending ? 'Signing in…' : 'Sign in'}
          </SubmitButton>
          <Problem error={signIn.error} />
        </form>
      )}
      {passwordEnabled && providers.length > 0 && <Or />}
      <ProviderLinks providers={providers} intent="sign-in" returnTo={hereForReturn()} />
    </AuthScreen>
  );
}

/**
 * Takes a secret out of the address bar's fragment, once. The fragment never
 * reaches the server or its logs; removing it keeps it out of the history
 * and of anything that copies the address from here on.
 */
export function useFragmentSecret(): string | null {
  const [secret] = useState(() => {
    const value = globalThis.location.hash.slice(1);
    if (value) {
      globalThis.history.replaceState(null, '', globalThis.location.pathname);
    }
    return value || null;
  });
  return secret;
}

/**
 * `/invite#…`: joining with an invitation, or setting a new password with a
 * reset link. Shown whoever is signed in, because the link is the subject.
 */
export function InviteScreen() {
  const token = useFragmentSecret();
  const session = useSession();
  const queryClient = useQueryClient();
  const providers = session.data?.providers ?? [];
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [dead, setDead] = useState<string | null>(
    token ? null : 'Open the link from your invitation again.',
  );
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Error | null>(null);
  const [reset, setReset] = useState(false);

  useEffect(() => {
    if (!token) return;
    void api.POST('/api/invitations/inspect', { body: { token } }).then(({ data, error }) => {
      if (data) setInfo(data);
      else setDead(problemDetail(error, 'this link is not valid'));
    });
  }, [token]);

  const joining = info?.purpose === 'join';
  const ready =
    password !== '' && (!joining || (displayName.trim() !== '' && username.trim() !== ''));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || !ready || busy) return;
    setBusy(true);
    setProblem(null);
    const body = joining
      ? { token, password, username: username.trim(), displayName: displayName.trim() }
      : { token, password };
    const { error, response } = await api.POST('/api/invitations/redeem', { body });
    setBusy(false);
    if (!response.ok) return setProblem(new Error(problemDetail(error, 'that did not work')));
    if (joining) {
      globalThis.history.replaceState(null, '', '/');
      await queryClient.invalidateQueries({ queryKey: sessionKey });
      globalThis.location.assign('/');
    } else {
      setReset(true);
    }
  }

  async function viaProvider(provider: string) {
    if (!token) return;
    setProblem(null);
    const { data, error } = await api.POST('/api/invitations/redeem/{provider}', {
      params: { path: { provider } },
      body: { token },
    });
    if (data) globalThis.location.assign(data.redirect);
    else setProblem(new Error(problemDetail(error, 'that sign-in could not be started')));
  }

  if (dead) {
    return (
      <AuthScreen title="Invitation">
        <p className="text-ink" role="alert">
          {dead}
        </p>
        <a href="/" className="mt-4 block text-ink-dim underline">
          Go to sign-in
        </a>
      </AuthScreen>
    );
  }
  if (!info) return <div className="h-full bg-surface-sunken" />;
  if (reset) {
    return (
      <AuthScreen title="Password set">
        <p className="text-ink">
          Your password is changed, and every other session of yours is signed out.
        </p>
        <a href="/" className="mt-4 block text-ink-dim underline">
          Sign in
        </a>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={joining ? 'Join this instance' : `New password for ${info.username ?? 'your account'}`}
    >
      {info.passwordEnabled && (
        <form onSubmit={submit}>
          {joining && (
            <>
              <Field
                label="Your name"
                value={displayName}
                onChange={setDisplayName}
                autoComplete="name"
              />
              <Field
                label="Username"
                value={username}
                onChange={setUsername}
                autoComplete="username"
              />
            </>
          )}
          <Field
            label={joining ? 'Password' : 'New password'}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="new-password"
          />
          <SubmitButton disabled={!ready || busy}>
            {busy ? 'Saving…' : joining ? 'Create my account' : 'Set password'}
          </SubmitButton>
        </form>
      )}
      {joining && providers.length > 0 && (
        <>
          {info.passwordEnabled && <Or />}
          <div className="mt-4">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void viaProvider(p.id)}
                className="mt-2 w-full rounded-sm border border-line-strong px-2 py-1 text-ink hover:bg-surface-raised"
              >
                Join with {p.name}
              </button>
            ))}
          </div>
        </>
      )}
      <Problem error={problem} />
      <p className="mt-6 text-[11px] text-ink-dim">
        {joining
          ? `${info.note ? `${info.note}. ` : ''}${info.admin ? 'You will administer this instance. ' : ''}Everyone with an account here can see every board and every image.`
          : 'This link works once. Setting a password signs you out everywhere else.'}
      </p>
    </AuthScreen>
  );
}

/**
 * `/device?port&challenge&state&label`: the desktop app asking to be signed
 * in as you (ADR-0027). Reached signed in — the gate shows sign-in first — so
 * the question is only whether to allow it.
 */
export function DeviceScreen() {
  const session = useSession();
  const [params] = useState(() => new URLSearchParams(globalThis.location.search));
  const [problem, setProblem] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'allowed' | 'cancelled' | null>(null);
  const label = params.get('label') || 'Visarium Desktop';
  const me = session.data?.user;

  async function allow() {
    setBusy(true);
    const { data, error } = await api.POST('/api/device/authorize', {
      body: {
        port: Number(params.get('port')),
        challenge: params.get('challenge') ?? '',
        state: params.get('state') ?? '',
        label,
      },
    });
    setBusy(false);
    if (!data)
      return setProblem(new Error(problemDetail(error, 'the desktop app could not be signed in')));
    setDone('allowed');
    globalThis.location.assign(data.redirect);
  }

  if (done === 'cancelled') {
    return (
      <AuthScreen title="Not allowed">
        <p className="text-ink">Nothing was signed in. You can close this tab.</p>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen title="Sign in the desktop app">
      <p className="text-ink">
        Allow <span className="text-ink">{label}</span> to sign in as {me?.displayName}?
      </p>
      <p className="mt-2 text-[11px] text-ink-dim">
        It stays signed in until you sign it out, from Settings on any browser.
      </p>
      <button
        type="button"
        onClick={() => void allow()}
        disabled={busy || done === 'allowed'}
        className="mt-4 w-full rounded-sm border border-line-strong px-2 py-1 text-ink hover:bg-surface-raised disabled:text-ink-disabled"
      >
        {done === 'allowed' ? 'Allowed — return to the app' : 'Allow'}
      </button>
      <button
        type="button"
        onClick={() => setDone('cancelled')}
        className="mt-2 w-full rounded-sm px-2 py-1 text-ink-dim hover:bg-surface-raised"
      >
        Cancel
      </button>
      <Problem error={problem} />
    </AuthScreen>
  );
}
