/**
 * Take out's drag in the desktop app: the originals leave as real files, through
 * a native drag the app starts for the page (`desktop/src/drag_out.rs`,
 * ADR-0028).
 *
 * A browser cannot do this. A `File` added to a `DataTransfer` never leaves it,
 * a dragged `<img>` leaves as a file promise that Finder and chat apps ignored
 * in every engine tried, and the content URL needs a session the drop target
 * does not have (docs/research/drag-out-images.md). So browsers keep Take out's
 * ordinary drag, and Copy is their way out.
 *
 * Two halves, for the reason the warm exists: a drag cannot wait. Each original
 * is written to a temp file as soon as it arrives, and a press-and-move then
 * only names the files. The move starts the drag, not `dragstart`: a cancelled
 * HTML drag makes WKWebView clear the system drag pasteboard after the native
 * drag has written to it, and every drop is refused.
 *
 * Anything short of a grant — a browser, a page the app has not signed in to,
 * a staging that failed — leaves nothing staged, and the control falls back to
 * the ordinary drag.
 */

interface TauriInternals {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
}

/** Read on every call rather than once, so a test can install one. */
const tauri = () => (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** Staged paths by asset id, once written. Read synchronously by the control. */
const staged = new Map<string, string>();
/** Asked for, staged or not — so a second arrival does not stage twice. */
const asked = new Set<string>();

/**
 * Writes an original to a temp file in the desktop app, once per asset.
 * Resolves when it is on disk, so the control can redraw as draggable; answers
 * `undefined` where there is nothing to do.
 */
export function stageOriginal(assetId: string, file: File): Promise<void> | undefined {
  const app = tauri();
  if (!app || asked.has(assetId)) return undefined;
  asked.add(assetId);
  // Base64 in plain JSON, never a raw `ArrayBuffer` body: a server's https page
  // reaches the app through `postMessage`, which would turn one into an array
  // of numbers (see drag_out.rs). The app sanitises the name itself.
  return base64(file)
    .then((data) => app.invoke('drag_stage', { asset: assetId, name: file.name, data }))
    .then((path) => {
      staged.set(assetId, path as string);
    });
}

/** The file as base64, encoded natively rather than a byte at a time in script. */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Whether every one of these can leave as a file, right now. */
export function nativeDragReady(assetIds: readonly string[]): boolean {
  return assetIds.length > 0 && assetIds.every((id) => staged.has(id));
}

/** Starts the native drag of staged originals, from a press that has moved. */
export function startNativeDrag(assetIds: readonly string[]): void {
  const app = tauri();
  const paths = assetIds.flatMap((id) => staged.get(id) ?? []);
  if (!app || paths.length === 0) return;
  app.invoke('drag_out', { paths }).catch((error: unknown) => {
    console.warn('drag out failed', error);
  });
}
