import { describe, expect, it } from 'vitest';
import { readCookie } from './client';

describe('readCookie', () => {
  it('finds a token among several cookies', () => {
    expect(readCookie('XSRF-TOKEN', 'a=1; XSRF-TOKEN=abc123; SESSION=zz')).toBe('abc123');
  });

  it('does not match a cookie whose name merely ends with the target', () => {
    expect(readCookie('TOKEN', 'XSRF-TOKEN=abc123')).toBeUndefined();
  });

  it('decodes percent-encoded values', () => {
    expect(readCookie('t', 't=a%2Bb%3D')).toBe('a+b=');
  });

  it('returns undefined when absent or when there are no cookies', () => {
    expect(readCookie('missing', 'a=1')).toBeUndefined();
    expect(readCookie('a', '')).toBeUndefined();
  });
});
