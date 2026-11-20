import { describe, expect, it } from 'vitest';
import { routePattern } from './desktop';

describe('routePattern', () => {
  it('takes IDs out of a path', () => {
    expect(routePattern('/boards/0190a0b0-0000-7000-8000-000000000000')).toBe('/boards/:id');
    expect(routePattern('/boards/0190a0b0-0000-7000-8000-000000000000/items/42')).toBe(
      '/boards/:id/items/42',
    );
  });

  it('keeps the words of a route', () => {
    expect(routePattern('/settings')).toBe('/settings');
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/s')).toBe('/s');
  });
});
