import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids';

describe('uuidv7', () => {
  it('looks like a UUID with version 7 and the RFC 9562 variant', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts lexicographically by creation time', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it('is unique within a millisecond', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(2000);
  });
});
