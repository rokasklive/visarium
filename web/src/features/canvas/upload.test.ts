import { describe, expect, it, vi } from 'vitest';
import { type UploadedAsset, UploadQueue, UploadRefused } from './upload';

const asset: UploadedAsset = { assetId: 'a1', width: 4000, height: 3000 };

function file(name = 'ref.jpg') {
  return new File(['bytes'], name, { type: 'image/jpeg' });
}

/** An uploader that only resolves when the test says so. */
function controllable() {
  const gates: (() => void)[] = [];
  const upload = vi.fn(
    () => new Promise<UploadedAsset>((resolve) => gates.push(() => resolve(asset))),
  );
  return {
    upload,
    gates,
    releaseAll: () => {
      for (const open of gates.splice(0)) open();
    },
  };
}

describe('the upload queue', () => {
  it('hands back the asset the server made', async () => {
    const resolved = vi.fn();
    const queue = new UploadQueue({ upload: async () => asset });

    queue.add('item-1', file(), resolved);
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(asset));
  });

  it('does not open forty connections for forty images', async () => {
    const { upload, releaseAll } = controllable();
    const queue = new UploadQueue({ upload, concurrency: 4 });

    for (let i = 0; i < 40; i += 1) queue.add(`item-${i}`, file(), () => {});

    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    expect(queue.status.active).toBe(4);
    expect(queue.status.queued).toBe(36);

    releaseAll();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(8));
  });

  it('drains the whole queue', async () => {
    const resolved = vi.fn();
    const queue = new UploadQueue({ upload: async () => asset, concurrency: 2 });

    for (let i = 0; i < 10; i += 1) queue.add(`item-${i}`, file(), resolved);

    await vi.waitFor(() => expect(resolved).toHaveBeenCalledTimes(10));
    expect(queue.status).toEqual({ queued: 0, active: 0 });
  });

  it('retries a dropped connection before giving up', async () => {
    let attempts = 0;
    const queue = new UploadQueue({
      retryDelayMs: 0,
      upload: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('connection reset');
        return asset;
      },
    });

    const resolved = vi.fn();
    queue.add('item-1', file(), resolved);

    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(asset));
    expect(attempts).toBe(3);
  });

  it('says so out loud when a reference does not land', async () => {
    const onFailure = vi.fn();
    const queue = new UploadQueue({
      retryDelayMs: 0,
      upload: async () => {
        throw new Error('507 out of space');
      },
      onFailure,
    });

    queue.add('item-1', file('holiday.png'), () => {});

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      id: 'item-1',
      name: 'holiday.png',
      reason: '507 out of space',
    });
  });

  it('does not retry what the server refused, and says its reason', async () => {
    let attempts = 0;
    const onFailure = vi.fn();
    const queue = new UploadQueue({
      retryDelayMs: 0,
      upload: async () => {
        attempts += 1;
        throw new UploadRefused('Image storage on this instance is full');
      },
      onFailure,
    });

    queue.add('item-1', file('holiday.png'), () => {});

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(attempts).toBe(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      reason: 'Image storage on this instance is full',
    });
  });

  it('keeps going after one upload fails', async () => {
    const resolved = vi.fn();
    let call = 0;
    const queue = new UploadQueue({
      retryDelayMs: 0,
      concurrency: 1,
      upload: async () => {
        call += 1;
        if (call <= 3) throw new Error('nope'); // first job, all its attempts
        return asset;
      },
    });

    queue.add('bad', file(), resolved);
    queue.add('good', file(), resolved);

    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(asset));
  });

  it('reports progress as it goes', async () => {
    const seen: { queued: number; active: number }[] = [];
    const { upload, releaseAll } = controllable();
    const queue = new UploadQueue({ upload, concurrency: 1, onStatus: (s) => seen.push(s) });

    queue.add('a', file(), () => {});
    queue.add('b', file(), () => {});
    await vi.waitFor(() => expect(queue.status.active).toBe(1));
    expect(queue.status.queued).toBe(1);

    releaseAll();
    await vi.waitFor(() => expect(queue.status.queued).toBe(0));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('stops taking new work when the board goes away', async () => {
    const { upload } = controllable();
    const queue = new UploadQueue({ upload, concurrency: 1 });

    queue.add('a', file(), () => {});
    queue.add('b', file(), () => {});
    queue.stop();

    expect(queue.status.queued).toBe(0);
  });
});
