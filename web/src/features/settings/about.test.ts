import { describe, expect, it } from 'vitest';
import { notesFor } from './about';

describe('the changelog in About', () => {
  it('finds a version under its v-prefixed heading', () => {
    expect(notesFor('0.1.0')?.length).toBeGreaterThan(0);
  });
  it('finds nothing for a version it does not list', () => {
    expect(notesFor('9.9.9')).toBeUndefined();
    expect(notesFor(undefined)).toBeUndefined();
  });
});
