/**
 * A selection leaving Visarium: the original bytes, and the system clipboard.
 *
 * The only module in the product that knows what a `ClipboardItem` is, because
 * the clipboard is the one place the platform gets a vote and the vote is
 * inconsistent. Two guarantees, and they are deliberately different:
 *
 *  - **The drag never falls back.** A `File` built here is the original bytes at
 *    the original resolution with the original name. If it cannot be fetched,
 *    the transfer carries no file — never a derivative and never a re-encode.
 *  - **The clipboard always may.** A page cannot put a filesystem file on the OS
 *    clipboard; `ClipboardItem` writes MIME-typed data, formats are refused
 *    unevenly, and Chromium re-encodes an image as part of sanitising it. So the
 *    format may change. The RESOLUTION may not, and that is the line below that
 *    must not be crossed.
 *
 * Neither gesture touches the document, the history, the socket or the database.
 * The only request either makes is for the content being handed over.
 *
 * See openspec `asset-interchange` and OPEN_QUESTIONS Q18.
 */

import { contentUrl, contentUrlList, type OutwardAsset } from './capture';

/**
 * An asset's original, as a named file.
 *
 * The name and the type come off the response rather than from a second request
 * for metadata: `GET …/content` states both, which is what M09 added the
 * `Content-Disposition` for.
 *
 * Held as a `Blob` and never as an `ArrayBuffer`, so the browser may spill a
 * 6000px photograph to disk rather than to the heap.
 */
export async function fetchOriginal(assetId: string, signal?: AbortSignal): Promise<File> {
  // Both at once. The name is a few hundred bytes against an original's
  // megabytes, so it lands long before the blob and costs no wall-clock time.
  const named = storedName(assetId, signal);
  const response = await fetch(contentUrl(assetId), signal ? { signal } : {});
  if (!response.ok) throw new Error(`could not fetch the original: ${response.status}`);
  const blob = await response.blob();
  const type = response.headers.get('content-type') || blob.type || 'application/octet-stream';
  const name =
    (await named) ??
    filenameFrom(response.headers.get('content-disposition')) ??
    `${assetId}.${type.split('/')[1] ?? 'bin'}`;
  return new File([blob], name, { type });
}

/**
 * What the asset record says it is called — and why that beats the header on the
 * bytes, which M09 added for exactly this and cannot be trusted with it.
 *
 * `…/content` is `immutable` for a year, and the library grid renders that same
 * URL as an `<img>` at the original tier. So the browser holds a cached response
 * for anything anyone has looked at, and a plain `fetch` is answered from it
 * without ever reaching the server. Two consequences, and the second is not a
 * migration problem that goes away:
 *
 *  - a response cached before the header shipped has no header at all, and
 *  - **renaming an asset never changes it**, because nothing revalidates an
 *    immutable response — the old name would be dragged out for a year.
 *
 * The metadata endpoint is small and ordinarily cached, so it revalidates and
 * tells the truth. The header stays as the fallback for when this request fails,
 * and stays on the server for a person who opens the URL and saves it.
 */
async function storedName(assetId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`/api/assets/${assetId}`, signal ? { signal } : {});
    if (!response.ok) return undefined;
    const asset = (await response.json()) as { originalFilename?: string };
    return asset.originalFilename || undefined;
  } catch {
    // Aborted, offline, or not JSON. The header below is still worth reading.
    return undefined;
  }
}

/**
 * The filename the response declared.
 *
 * `filename*` first: the server writes both, and the plain one loses anything the
 * header's own encoding cannot hold — which is the entire reason the encoded
 * form is there.
 */
function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed escape. The plain form below is still worth something.
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] || undefined;
}

/**
 * No warm yet.
 *
 * Shared rather than allocated per call: a keypress has no hover to precede it,
 * and a drag can begin before the first fetch lands. Both cases are ordinary.
 */
export const NO_ORIGINALS: ReadonlyMap<string, File> = new Map();

/** Originals in flight, and the way to stop wanting them. */
export interface Warm {
  /**
   * What has arrived, keyed by asset id. Read SYNCHRONOUSLY by `dragstart`,
   * which is the whole reason this exists.
   */
  readonly originals: ReadonlyMap<string, File>;
  /** Abandon what has not arrived — the pointer left. */
  abort(): void;
}

/**
 * Fetch originals ahead of a drag that has not started yet.
 *
 * `DataTransfer.items.add` needs a `File` in hand at the instant `dragstart`
 * runs, and there is no await inside `dragstart`. So the bytes are warmed on a
 * real intent signal — a pointer entering the control — hundreds of milliseconds
 * earlier, and abandoned when it leaves.
 *
 * This is not a canvas pointer handler, so invariant 6 is untouched: no pointer
 * handler on the canvas awaits a request; a hover on a button is not that
 * handler.
 *
 * No bound on the count. A selection of fifty warms fifty, held as `Blob`s the
 * browser may spill to disk, against an endpoint cached as immutable so a second
 * drag of the same selection costs nothing. If a real measurement produces a
 * number, it becomes a constant and an open question — not a literal invented
 * here.
 */
export function warmOriginals(assetIds: readonly string[], onArrive?: () => void): Warm {
  const originals = new Map<string, File>();
  const controller = new AbortController();
  for (const assetId of assetIds) {
    void fetchOriginal(assetId, controller.signal)
      .then((file) => {
        originals.set(assetId, file);
        // The control draws itself differently once it has something to hand
        // over, so it has to hear about it. Nothing else here notifies.
        onArrive?.();
      })
      .catch(() => {
        // Aborted, or the fetch failed. Either way this asset carries no file,
        // and the drag reports that rather than substituting something smaller.
      });
  }
  return { originals, abort: () => controller.abort() };
}

/**
 * What the clipboard turned out to be able to carry. Three answers, which is
 * exactly what the interface has to be able to say.
 */
export type CopyOutcome =
  /** The original's own format, at the original's resolution. Routine, and silent. */
  | 'original'
  /** The browser refused the original's format, so PNG — at the same resolution. */
  | 'png'
  /** No Clipboard API on this origin, or the write was refused. Dragging out still works. */
  | 'unavailable';

/**
 * A selection on the system clipboard.
 *
 * Called **synchronously inside the gesture**, with promises as the
 * `ClipboardItem` values: Safari refuses a `write()` reached after an await, so
 * the type is decided before the call and the bytes are produced afterwards.
 * There is no await in this function before `write()`, and there must not be.
 *
 * One image, because Chromium implements a single `ClipboardItem` per write. It
 * is the topmost of the selection — the same one the drag shows as its drag
 * image — and `text/plain` carries a URL for every selected image regardless, so
 * a paste into a target that takes no image still resolves to all of them.
 */
export async function copySelection(
  assets: readonly OutwardAsset[],
  originals: ReadonlyMap<string, File>,
): Promise<CopyOutcome> {
  const top = assets.at(-1);
  if (!top) return 'unavailable';
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    // The Clipboard API exists only in a secure context, and
    // `http://nas.local:8080` — the deployment this product is FOR — is not one.
    // There is no engineering answer; the answer is saying so. See DEPLOYMENT.md.
    return 'unavailable';
  }

  // Feature-detected, and PNG where the method does not exist: PNG is the one
  // type every implementation of this API accepts. Decided from what the warm
  // already holds, because there is no await to be had before `write()`.
  const original = originals.get(top.assetId);
  const preferred = original?.type;
  const type = preferred && supportsType(preferred) ? preferred : 'image/png';

  // Reported from what was actually carried rather than from what was chosen: a
  // PNG original written as PNG changed nothing and must stay silent.
  let changedFormat = false;
  const source: Promise<Blob> = original ? Promise.resolve(original) : fetchOriginal(top.assetId);
  const image = source.then((blob) => {
    if (blob.type === type) return blob;
    changedFormat = true;
    return asPng(blob);
  });

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [type]: image,
        'text/plain': new Blob([contentUrlList(assets)], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    // A refused type rejects the whole write, and so does an origin that turned
    // out not to be secure after all. Neither throws past the caller: there is a
    // working alternative to name, and naming it is the point.
    return 'unavailable';
  }
  return changedFormat ? 'png' : 'original';
}

/** `ClipboardItem.supports` is recent enough that its absence is the common case. */
function supportsType(type: string): boolean {
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return supports ? supports(type) : false;
}

/**
 * The original, re-encoded as PNG at its own pixel dimensions.
 *
 * `createImageBitmap` is already this codebase's decoder, and the canvas is
 * sized from the bitmap rather than from anything the caller supplies. The
 * format changes here; the resolution does not, and that is the line this
 * function must not cross.
 */
async function asPng(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context to re-encode through');
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/**
 * What the interface says when a gesture did not do the guaranteed thing.
 *
 * Each names the alternative rather than only the problem: there is always
 * another way to get the image out, and pointing at it is what makes a notice
 * useful rather than merely polite. A copy that carried the original's format is
 * absent on purpose — routine success is silent, which is the rule the upload
 * failures already follow.
 */
export const NOTICES = {
  png: 'Copied as PNG — this browser would not take the original format. Drag out for the original file.',
  unavailable:
    'No clipboard on this origin — the Clipboard API needs a secure connection. Drag out for the original file.',
  notWarm:
    'The originals are not ready yet, so nothing was dragged. They are being fetched — drag again in a moment.',
  notStored: 'Not stored yet — an item that is still uploading has nothing to take out.',
} as const;

/**
 * Why a drag out cannot go, if it cannot.
 *
 * A non-null answer **cancels the drag** rather than annotating it. A drag
 * carrying no file is indistinguishable from one carrying a file until it lands
 * somewhere and nothing arrives — and the person is watching the pointer, not
 * the status strip, while that happens.
 *
 * Two ways to have nothing to carry, and they are not the same thing to the
 * person: nothing in the selection is stored yet, or the bytes have not arrived.
 * A partial warm still goes — some files travelled, which is the ordinary case
 * for a large selection dragged quickly.
 */
export function dragNotice(
  assets: readonly OutwardAsset[],
  originals: ReadonlyMap<string, File>,
): string | null {
  if (assets.length === 0) return NOTICES.notStored;
  if (originals.size === 0) return NOTICES.notWarm;
  return null;
}
