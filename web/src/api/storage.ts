import type { StorageUsage } from '@visarium/api-client';

/** At this share of the limit (or of what the disk still has), it is said out loud. */
export const NEARLY_FULL = 0.9;

/** "9.8 GB": decimal units, as the server's own messages and Finder say them. */
export function bytesText(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.ceil(n / 1e3)} KB`;
}

export interface StorageState {
  /** used / of, for the bar; may pass 1 when a limit was set below what is stored. */
  readonly fraction: number;
  readonly of: number;
  readonly level: 'ok' | 'nearly' | 'full';
  readonly summary: string;
  readonly warning: string | null;
}

/**
 * What the gauge says. With a limit, it measures against the limit, unless
 * the disk will run out first. Without one, it measures against the disk.
 */
export function storageState(u: StorageUsage): StorageState {
  const used = u.usedBytes;
  const diskRoom =
    u.diskFreeBytes == null ? null : Math.max(0, u.diskFreeBytes - u.diskReserveBytes);

  if (u.limitBytes != null) {
    const limit = u.limitBytes;
    const left = Math.max(0, limit - used);
    const summary = `${bytesText(used)} of ${bytesText(limit)} used`;
    if (used >= limit) {
      return {
        fraction: used / limit,
        of: limit,
        level: 'full',
        summary,
        warning:
          'Full: new images are refused until some are purged from the trash or the limit is raised.',
      };
    }
    if (diskRoom != null && diskRoom < left) {
      return {
        fraction: used / limit,
        of: limit,
        level: diskRoom === 0 ? 'full' : 'nearly',
        summary,
        warning:
          diskRoom === 0
            ? 'The disk is full before the limit is: new images are refused. Free space on the server.'
            : `The disk will run out before the limit: ${bytesText(diskRoom)} left for images.`,
      };
    }
    const fraction = used / limit;
    return {
      fraction,
      of: limit,
      level: fraction >= NEARLY_FULL ? 'nearly' : 'ok',
      summary,
      warning: fraction >= NEARLY_FULL ? `Nearly full: ${bytesText(left)} left.` : null,
    };
  }

  if (diskRoom == null) {
    return {
      fraction: 0,
      of: Math.max(used, 1),
      level: 'ok',
      summary: `${bytesText(used)} used · no limit`,
      warning: null,
    };
  }
  const of = used + diskRoom;
  const fraction = of === 0 ? 0 : used / of;
  const level = diskRoom === 0 ? 'full' : fraction >= NEARLY_FULL ? 'nearly' : 'ok';
  return {
    fraction,
    of,
    level,
    summary: `${bytesText(used)} used · no limit · ${bytesText(diskRoom)} more fits on the disk`,
    warning:
      level === 'full'
        ? 'The disk is full: new images are refused. Free space on the server, or purge the trash.'
        : level === 'nearly'
          ? `The disk is nearly full: ${bytesText(diskRoom)} left for images.`
          : null,
  };
}
