import { useQuery, useQueryClient } from '@tanstack/react-query';
import { codenameFor, fetchServerInfo } from '@visarium/api-client';
import { type ComponentType, useState } from 'react';
import { checkForUpdates, collectDiagnostics, localPort, updatePreferences } from '~/api/desktop';
import { SOURCE } from '~/app/source';
import changelog from '../../../../CHANGELOG.md?raw';

declare const __VISARIUM_BUILD__: string;

const link = 'underline underline-offset-2 hover:text-ink';

type UpdateView = { type: 'checking' } | { type: 'message'; text: string };

/** The CHANGELOG lines for `version` (bare semver), under `## vX.Y.Z` or `## X.Y.Z`. */
export function notesFor(version: string | undefined) {
  return changelog
    .split(/^## /m)
    .slice(1)
    .map((section) => section.trim().split('\n'))
    .find(([heading]) => version !== undefined && heading?.trim().replace(/^v/, '') === version)
    ?.slice(1)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

export function About({
  Heading,
  Button,
}: {
  Heading: ComponentType<{ children: string }>;
  Button: ComponentType<{ children: string; onClick: () => void; disabled?: boolean }>;
}) {
  const server = useQuery({ queryKey: ['server-info'], queryFn: () => fetchServerInfo() });
  const desktop = useQuery({
    queryKey: ['desktop-library'],
    queryFn: async () => (await localPort()) !== undefined,
  });
  const [update, setUpdate] = useState<UpdateView>();
  /** The box as last clicked, ahead of the app's answer. */
  const [chosen, setChosen] = useState<boolean>();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: ['update-preferences'],
    queryFn: () => updatePreferences(),
    enabled: desktop.data === true,
  });
  const version = server.data?.version;
  const notes = notesFor(version);

  async function check() {
    setUpdate({ type: 'checking' });
    try {
      const result = desktop.data ? await checkForUpdates() : { status: 'unconfigured' };
      setUpdate(
        result.status === 'available'
          ? // The app's own update window has it from here.
            undefined
          : {
              type: 'message',
              text:
                result.status === 'current'
                  ? 'Visarium is up to date.'
                  : 'App updates are unavailable on this installation.',
            },
      );
    } catch (error) {
      setUpdate({ type: 'message', text: (error as Error).message });
    }
  }

  async function setAutomatic(automatic: boolean) {
    setChosen(automatic);
    try {
      queryClient.setQueryData(['update-preferences'], await updatePreferences(automatic));
    } catch (error) {
      setUpdate({ type: 'message', text: (error as Error).message });
    }
    setChosen(undefined);
  }

  return (
    <section aria-label="About">
      <Heading>About</Heading>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
        <dt className="text-ink-dim">Version</dt>
        <dd className="flex flex-wrap items-center gap-3">
          <span>
            {version ? `v${version}` : '—'}
            {codenameFor(version) ? (
              <span className="ml-2 text-ink-dim italic">{codenameFor(version)}</span>
            ) : null}
          </span>
          <Button
            disabled={desktop.isPending || update?.type === 'checking'}
            onClick={() => void check()}
          >
            Check for Updates
          </Button>
        </dd>
        {preferences.data ? (
          <>
            <dt className="text-ink-dim">Updates</dt>
            <dd>
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={chosen ?? preferences.data.automatic}
                  onChange={(e) => void setAutomatic(e.target.checked)}
                />
                Check for updates automatically
              </label>
            </dd>
          </>
        ) : null}
        <dt className="text-ink-dim">Build</dt>
        <dd>{__VISARIUM_BUILD__}</dd>
        {/* The AGPL's "Appropriate Legal Notices" (§5d) and source offer (§13).
            New windows: the desktop app hands them to the system browser. */}
        <dt className="text-ink-dim">Licence</dt>
        <dd>
          © 2026 Rokas Kučinskas. Free software under the{' '}
          <a className={link} href="/licenses.txt" target="_blank" rel="noreferrer">
            GNU AGPL v3.0
          </a>
          , with no warranty.{' '}
          <a className={link} href={SOURCE} target="_blank" rel="noreferrer">
            Source code
          </a>
          {' · '}
          <a className={link} href="/licenses.txt" target="_blank" rel="noreferrer">
            Third-party licences
          </a>
        </dd>
      </dl>
      <div className="mt-2 text-ink-dim" role="status" aria-live="polite">
        {update?.type === 'checking' ? 'Checking for updates…' : null}
        {update?.type === 'message' ? update.text : null}
      </div>
      <h3 className="mt-4 mb-2 text-[11px] uppercase tracking-wide text-ink-dim">Changelog</h3>
      {notes?.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-dim">
          {server.isPending ? 'Loading changelog…' : 'No changelog is available for this version.'}
        </p>
      )}
    </section>
  );
}

/**
 * A file to attach to a bug report, saved here and sent nowhere. Says what is in
 * it, because "diagnostics" alone reads like it could be anything.
 */
export function Diagnostics({
  Heading,
  Button,
}: {
  Heading: ComponentType<{ children: string }>;
  Button: ComponentType<{ children: string; onClick: () => void; disabled?: boolean }>;
}) {
  const server = useQuery({ queryKey: ['server-info'], queryFn: () => fetchServerInfo() });
  const desktop = useQuery({
    queryKey: ['desktop-library'],
    queryFn: async () => (await localPort()) !== undefined,
  });
  const [collecting, setCollecting] = useState(false);
  const [bundleMessage, setBundleMessage] = useState('');
  const version = server.data?.version;

  async function collect() {
    setCollecting(true);
    setBundleMessage('');
    try {
      if (desktop.data) {
        const name = await collectDiagnostics(__VISARIUM_BUILD__);
        setBundleMessage(`Saved ${name} in Downloads.`);
      } else {
        const data = {
          version,
          build: __VISARIUM_BUILD__,
          protocolVersion: server.data?.protocolVersion,
          events: [
            {
              time: new Date().toISOString(),
              source: 'settings.collect_diagnostics',
              level: 'info',
            },
          ],
        };
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'visarium-diagnostics.json';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setBundleMessage('Downloaded visarium-diagnostics.json.');
      }
    } catch (error) {
      setBundleMessage(error instanceof Error ? error.message : 'Could not collect diagnostics.');
    } finally {
      setCollecting(false);
    }
  }

  return (
    <section className="mb-6 border-b border-line pb-6" aria-label="Diagnostics">
      <Heading>Diagnostics</Heading>
      <p className="mb-3 text-ink-dim">
        If something goes wrong, save a diagnostic file and attach it to your report.{' '}
        {desktop.data
          ? 'It holds the version, build and system, and when and where recent warnings and errors happened — never their text, and nothing from your boards. It is saved to Downloads and sent nowhere.'
          : 'It holds the version and build, and nothing from your boards. Your browser downloads it; it is sent nowhere.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={collecting || desktop.isPending} onClick={() => void collect()}>
          Save diagnostic file
        </Button>
        <span className="text-ink-dim" role="status">
          {bundleMessage}
        </span>
      </div>
    </section>
  );
}
