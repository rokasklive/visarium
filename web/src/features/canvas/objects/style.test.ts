import { describe, expect, it } from 'vitest';
import { objectCss } from './style';

const css = objectCss({ ink: 'INK', inkDim: 'DIM', accent: 'ACC', line: 'LINE', ground: 'GROUND' });

describe('the object stylesheet', () => {
  it('positions and transforms nothing (WebKit misplaces those in a scaled foreignObject)', () => {
    const properties = [...css.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(properties).not.toContain('position');
    expect(properties).not.toContain('transform');
    expect(properties).not.toContain('translate');
    expect(properties).not.toContain('rotate');
  });

  it('takes every colour it draws from the palette it is given', () => {
    const withoutUrls = css.replace(/url\([^)]*\)/g, '');
    expect(withoutUrls).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutUrls).not.toMatch(/\b(?:oklch|hsl)\(/);
    for (const token of ['INK', 'DIM', 'ACC', 'LINE', 'GROUND']) expect(css).toContain(token);
  });
});
