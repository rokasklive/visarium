import type { StorageUsage } from '@visarium/api-client';
import { describe, expect, it } from 'vitest';
import { bytesText, storageState } from './storage';

const GB = 1e9;
const usage = (over: Partial<StorageUsage>): StorageUsage => ({
  usedBytes: 0,
  trashBytes: 0,
  images: 0,
  limitBytes: null,
  diskFreeBytes: 500 * GB,
  diskTotalBytes: 1000 * GB,
  diskReserveBytes: 2 ** 30,
  ...over,
});

describe('storageState', () => {
  it('measures against the limit and warns from 90%', () => {
    expect(storageState(usage({ usedBytes: 5 * GB, limitBytes: 10 * GB }))).toMatchObject({
      fraction: 0.5,
      level: 'ok',
      summary: '5.0 GB of 10.0 GB used',
      warning: null,
    });
    expect(storageState(usage({ usedBytes: 9.5 * GB, limitBytes: 10 * GB }))).toMatchObject({
      level: 'nearly',
      warning: 'Nearly full: 500 MB left.',
    });
  });

  it('is full at or past the limit, even one set below what is stored', () => {
    const s = storageState(usage({ usedBytes: 12 * GB, limitBytes: 10 * GB }));
    expect(s.level).toBe('full');
    expect(s.fraction).toBeCloseTo(1.2);
  });

  it('says when the disk will run out before the limit', () => {
    const s = storageState(
      usage({ usedBytes: 1 * GB, limitBytes: 100 * GB, diskFreeBytes: 4 * GB }),
    );
    expect(s.level).toBe('nearly');
    expect(s.warning).toMatch(/disk will run out before the limit/);
  });

  it('without a limit, measures against the disk', () => {
    const s = storageState(usage({ usedBytes: 10 * GB, diskFreeBytes: 1 * GB }));
    expect(s.level).toBe('full');
    expect(storageState(usage({ usedBytes: 10 * GB, diskFreeBytes: null }))).toMatchObject({
      level: 'ok',
      summary: '10.0 GB used · no limit',
    });
  });
});

it('bytesText reads as people say sizes', () => {
  expect(bytesText(9_812_000_000)).toBe('9.8 GB');
  expect(bytesText(200_000_000)).toBe('200 MB');
  expect(bytesText(1_500)).toBe('2 KB');
});
