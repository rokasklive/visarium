/**
 * Getting a dropped file to the server, beside the interaction loop.
 *
 * North star 3: the user never saves. An item is on the board before this runs
 * and stays there while it runs, so nothing here is allowed to be in the way of
 * a gesture — invariant 4, no pointer handler awaits a request.
 *
 * The queue is bounded and in-process. Dropping forty images should not open
 * forty connections, and it should not need a message broker.
 */

import { api } from '@visarium/api-client';
import { problemDetail } from '~/api/session';

/** ASSET_STORAGE.md: three or four at a time. More is not faster over one disk. */
const CONCURRENCY = 4;

/**
 * A dropped reference that fails to upload is a reference the user believes
 * they filed. Two retries covers a dropped connection; after that it is said
 * out loud rather than swallowed.
 */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export interface UploadedAsset {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType?: string | undefined;
}

export interface UploadFailure {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface UploadStatus {
  readonly queued: number;
  readonly active: number;
}

export const IDLE: UploadStatus = { queued: 0, active: 0 };

export type Uploader = (file: File) => Promise<UploadedAsset>;

/**
 * The server said no for a reason another try will not change: the image is
 * too large, is not an image, or the instance's storage is full. Its message
 * is the one to show, and it is shown at once rather than after the retries.
 */
export class UploadRefused extends Error {}

/**
 * POST the file and read back what the server made of it.
 *
 * The schema marks every field optional, though the server always sends them.
 * Rather than guard at each use, the contract is asserted once, here.
 */
export const uploadAsset: Uploader = async (file) => {
  const result = await api.POST('/api/assets', {
    // The generated type calls the multipart part a string, because that is how
    // OpenAPI spells "binary". A File is what actually goes on the wire.
    body: { file: file as unknown as string },
    bodySerializer: (body) => {
      const form = new FormData();
      form.append('file', (body as unknown as { file: File }).file);
      return form;
    },
  });

  if (!result.data) {
    const status = result.response.status;
    const reason = problemDetail(result.error, `upload failed: ${status}`);
    // A 4xx (but a timeout or a throttle) or a 507 is about the file or the
    // instance; only a 5xx or the network is worth trying again.
    const refused =
      (status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 507;
    throw refused ? new UploadRefused(reason) : new Error(reason);
  }

  // Asserted once here rather than at each use.
  const { id, width, height, mimeType } = result.data;
  if (!id || !width || !height) {
    throw new Error('the server returned an asset with no identity or no size');
  }
  return { assetId: id, width, height, mimeType };
};

interface Job {
  readonly id: string;
  readonly file: File;
  readonly resolved: (asset: UploadedAsset) => void;
}

export class UploadQueue {
  readonly #waiting: Job[] = [];
  readonly #upload: Uploader;
  readonly #onStatus: (status: UploadStatus) => void;
  readonly #onFailure: (failure: UploadFailure) => void;
  readonly #concurrency: number;
  readonly #retryDelayMs: number;
  #active = 0;
  #stopped = false;

  constructor(
    options: {
      upload?: Uploader;
      onStatus?: (status: UploadStatus) => void;
      onFailure?: (failure: UploadFailure) => void;
      concurrency?: number;
      retryDelayMs?: number;
    } = {},
  ) {
    this.#upload = options.upload ?? uploadAsset;
    this.#onStatus = options.onStatus ?? (() => {});
    this.#onFailure = options.onFailure ?? (() => {});
    this.#concurrency = options.concurrency ?? CONCURRENCY;
    this.#retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  get status(): UploadStatus {
    return { queued: this.#waiting.length, active: this.#active };
  }

  /**
   * @param resolved called once the asset exists. The caller decides what that
   *   means for the board — including that the item has since been deleted.
   */
  add(id: string, file: File, resolved: (asset: UploadedAsset) => void): void {
    this.#waiting.push({ id, file, resolved });
    this.#report();
    this.#pump();
  }

  /** Stop starting new work. In-flight uploads are left to finish or fail. */
  stop(): void {
    this.#stopped = true;
    this.#waiting.length = 0;
  }

  #pump(): void {
    while (!this.#stopped && this.#active < this.#concurrency && this.#waiting.length > 0) {
      const job = this.#waiting.shift() as Job;
      this.#active += 1;
      this.#report();
      void this.#run(job);
    }
  }

  async #run(job: Job): Promise<void> {
    try {
      job.resolved(await this.#withRetries(job.file));
    } catch (cause) {
      this.#onFailure({
        id: job.id,
        name: job.file.name,
        reason: cause instanceof Error ? cause.message : 'upload failed',
      });
    } finally {
      this.#active -= 1;
      this.#report();
      this.#pump();
    }
  }

  async #withRetries(file: File): Promise<UploadedAsset> {
    let last: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        return await this.#upload(file);
      } catch (cause) {
        if (cause instanceof UploadRefused) throw cause;
        last = cause;
        if (attempt < ATTEMPTS) {
          await new Promise((resume) => setTimeout(resume, this.#retryDelayMs * attempt));
        }
      }
    }
    throw last instanceof Error ? last : new Error('upload failed');
  }

  #report(): void {
    this.#onStatus(this.status);
  }
}
