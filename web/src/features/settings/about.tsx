import { useQuery } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { codenameFor, fetchServerInfo } from '@visarium/api-client';
import { type ComponentType, useState } from 'react';
import { checkForUpdates, collectDiagnostics, installUpdate, localPort } from '~/api/desktop';
import changelog from '../../../../CHANGELOG.md?raw';

declare const __VISARIUM_BUILD__: string;

type UpdateView =
  | { type: 'checking' | 'installing' }
  | { type: 'available'; version: string; canInstall: boolean }
  | { type: 'message'; text: string };

const reopen =
  'Finish saving your work, reopen Visarium, and choose Settings from the startup screen.';

function notesFor(version: string | undefined) {
  return changelog
    .split(/^## /m)
    .slice(1)
    .map((section) => section.trim().split('\n'))
    .find(([heading]) => heading?.trim() === version)
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
  useBlocker({
    shouldBlockFn: () => update?.type === 'installing',
    enableBeforeUnload: false,
  });
  const [collecting, setCollecting] = useState(false);
  const [bundleMessage, setBundleMessage] = useState('');
  const version = server.data?.version;
  const notes = notesFor(version);

  async function check() {
    setUpdate({ type: 'checking' });
    try {
      const result = desktop.data ? await checkForUpdates() : { status: 'unconfigured' };
      if (result.status === 'available' && 'version' in result) {
        setUpdate({ type: 'available', version: result.version, canInstall: result.canInstall });
      } else {
        setUpdate({
          type: 'message',
          text:
            result.status === 'current'
              ? 'Visarium is up to date.'
              : 'App updates are unavailable on this installation.',
        });
      }
    } catch (error) {
      setUpdate({ type: 'message', text: (error as Error).message });
    }
  }

  async function install(offeredVersion: string) {
    setUpdate({ type: 'installing' });
    try {
      await installUpdate(offeredVersion);
    } catch (error) {
      setUpdate({ type: 'message', text: (error as Error).message });
    }
  }

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
    <section className="mt-6" aria-label="About">
      <Heading>About</Heading>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
        <dt className="text-ink-dim">Version</dt>
        <dd className="flex flex-wrap items-center gap-3">
          <span>
            {version ?? '—'}
            {codenameFor(version) ? (
              <span className="ml-2 text-ink-dim italic">{codenameFor(version)}</span>
            ) : null}
          </span>
          <Button
            disabled={
              desktop.isPending || update?.type === 'checking' || update?.type === 'installing'
            }
            onClick={() => void check()}
          >
            Check for Updates
          </Button>
        </dd>
        <dt className="text-ink-dim">Build</dt>
        <dd>{__VISARIUM_BUILD__}</dd>
      </dl>
      <div className="mt-2 text-ink-dim" role="status" aria-live="polite">
        {update?.type === 'checking' ? 'Checking for updates…' : null}
        {update?.type === 'installing'
          ? 'Downloading and verifying the update. Visarium will restart when it is ready.'
          : null}
        {update?.type === 'message' ? update.text : null}
        {update?.type === 'available' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Version {update.version}
              {codenameFor(update.version) ? ` (${codenameFor(update.version)})` : ''} is available.
            </span>
            {update.canInstall ? (
              <>
                <Button onClick={() => void install(update.version)}>Install and Restart</Button>
                <Button onClick={() => setUpdate(undefined)}>Later</Button>
              </>
            ) : (
              <span>{reopen}</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Button disabled={collecting || desktop.isPending} onClick={() => void collect()}>
          Collect bundle
        </Button>
        <span className="text-ink-dim" role="status">
          {bundleMessage}
        </span>
      </div>
      <h3 className="mb-2 text-[11px] uppercase tracking-wide text-ink-dim">Changelog</h3>
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
