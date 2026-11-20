/**
 * The desktop app's own commands, where the page runs inside it
 * (`desktop/src/local_port.rs`). In a browser, or on a server's pages, there is
 * no bridge and every call answers `undefined`.
 */

interface TauriInternals {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
}

/** Read on every call rather than once, so a test can install one. */
const tauri = () => (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export interface LocalPort {
  /** What the next launch will try. */
  readonly preferred: number;
  /** What this run is on. */
  readonly actual: number;
  readonly default: number;
}

/** The embedded library's port, or `undefined` outside the desktop app. */
export async function localPort(): Promise<LocalPort | undefined> {
  const app = tauri();
  if (!app) return undefined;
  try {
    return (await app.invoke('local_port')) as LocalPort;
  } catch {
    return undefined;
  }
}

/**
 * Moves the library to `value` now, and from then on. The app then moves this
 * window to the same page at the new address. Throws the app's message when
 * it refuses (a port that is not free, one below 1024).
 */
export async function setLocalPort(value: number): Promise<void> {
  const app = tauri();
  if (!app) throw new Error('only the desktop app has a local port to change');
  try {
    await app.invoke('set_local_port', { value });
  } catch (error) {
    const message = (error as { message?: string })?.message;
    throw new Error(message ?? 'the port could not be saved');
  }
}

/**
 * Text to the clipboard. The async API first; where a webview refuses it, the
 * old selection copy, which every engine still honours inside a click.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const done = document.execCommand('copy');
    field.remove();
    return done;
  }
}

export type UpdateStatus =
  | { status: 'available'; version: string; canInstall: boolean }
  | { status: 'current' | 'unconfigured' };

async function desktopCommand<T>(command: string, args?: unknown): Promise<T> {
  const app = tauri();
  if (!app) throw new Error('Open the desktop library to use this action.');
  try {
    return (await app.invoke(command, args)) as T;
  } catch (error) {
    throw new Error(
      typeof error === 'string' ? error : 'The desktop action could not be completed.',
    );
  }
}

export function checkForUpdates() {
  return desktopCommand<UpdateStatus>('check_for_updates');
}

export function installUpdate(version: string) {
  return desktopCommand<void>('install_update', { version });
}

export function collectDiagnostics(build: string) {
  return desktopCommand<string>('collect_diagnostics', { build });
}

export function markLibraryOpened() {
  // The native permission applies only to the embedded library.
  if (window.location.hostname === '127.0.0.1') {
    void tauri()
      ?.invoke('mark_library_opened')
      .catch(() => {});
  }
}
