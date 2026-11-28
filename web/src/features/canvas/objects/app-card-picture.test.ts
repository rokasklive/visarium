import { describe, expect, it } from 'vitest';
import { cleanCss, sizedCard } from './app-card';

describe("an app's picture (canvas/apps: a card is a snapshot of its view)", () => {
  // What a real browser keeps and drops is checked end to end
  // (canvas.apps.spec.ts): happy-dom parses too loosely to judge DOMPurify by.

  it('cleans CSS on its own: url() but data images, image-set() and @import', () => {
    expect(cleanCss('a{background:url( "x.png" )} b{src:url(data:image/svg+xml,AA)}')).toBe(
      'a{background:none} b{src:url(data:image/svg+xml,AA)}',
    );
    expect(cleanCss('@import "x.css"; a{background:image-set("a.png" 1x)}')).toBe(
      ' a{background:none}',
    );
  });

  it('carries the size of the view it was taken from', () => {
    expect(sizedCard('<p>x</p>', 298.4, 166)).toBe(
      '<div data-card-width="298" data-card-height="166"><p>x</p></div>',
    );
  });
});
