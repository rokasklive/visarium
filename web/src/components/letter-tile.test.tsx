import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fixture from '../../../packages/canvas-core/fixtures/presence-letters.json';
import { GLYPHS } from './letter-glyphs';
import { LetterTile, letterOf, tileLayout } from './letter-tile';
import { ROW_FILLS, ROWS } from './wordmark';

describe('letter glyphs', () => {
  it('has A-Z, 0-9 and the ? fallback, each eight rows on the half-pitch grid', () => {
    expect(Object.keys(GLYPHS).sort().join('')).toBe('0123456789?ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    for (const [letter, rows] of Object.entries(GLYPHS)) {
      expect(rows, letter).toHaveLength(ROWS.length);
      for (const row of rows) {
        expect(
          [...row].every((c, k) => c === '.' || k % 2 === 0),
          `${letter}: ${row}`,
        ).toBe(true);
      }
    }
  });

  it("draws V exactly as the wordmark's V", () => {
    const v = GLYPHS.V ?? [];
    ROWS.forEach((row, r) => {
      expect(row.slice(0, v[r]?.length).replace(/\.+$/, '')).toBe(v[r]?.replace(/\.+$/, ''));
    });
  });
});

describe('letterOf', () => {
  for (const [name, letter] of fixture.cases as [string, string][]) {
    it(`"${name}" is ${letter}`, () => {
      expect(letterOf(name)).toBe(letter);
    });
  }
});

describe('LetterTile', () => {
  it("shows a person's letter in their colour, named in full", () => {
    const markup = renderToStaticMarkup(<LetterTile name="Rokas" colour="red" />);
    expect(markup).toContain('data-letter="R"');
    expect(markup).toContain('aria-label="Rokas"');
    expect(markup).toContain('<title>Rokas</title>');
    expect(markup).toContain('fill="red"');
    expect(markup).not.toContain('stroke=');
  });

  it("outlines an agent's tile in its colour and says whose agent it is", () => {
    const label = 'Claude, an AI agent working for Rokas';
    const markup = renderToStaticMarkup(
      <LetterTile name="Claude" colour="teal" agent label={label} />,
    );
    expect(markup).toContain('stroke="teal"');
    expect(markup).toContain(`aria-label="${label}"`);
  });

  it("draws an agent's letter row by row in the wordmark colours, a person's in one", () => {
    const agent = renderToStaticMarkup(<LetterTile name="Claude" colour="teal" agent />);
    const fills = [...agent.matchAll(/<path[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills).toEqual([...ROW_FILLS]);
    expect(fills).not.toContain('teal');
    const person = renderToStaticMarkup(<LetterTile name="Ana" colour="teal" />);
    expect([...person.matchAll(/<path[^>]*fill="([^"]+)"/g)].map((m) => m[1])).toEqual(['teal']);
  });

  it('never draws an empty tile', () => {
    const markup = renderToStaticMarkup(<LetterTile name="🤖" colour="red" />);
    expect(markup).toContain('data-letter="?"');
    expect(tileLayout('?', 20, 1)).not.toBe('');
  });

  it('keeps every dot on whole device pixels inside the tile', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const size = Math.round(20 * dpr);
      for (const letter of Object.keys(GLYPHS)) {
        for (const [, x, y] of tileLayout(letter, size, dpr).matchAll(/M(-?\d+) (-?\d+)/g)) {
          expect(Number(x)).toBeGreaterThanOrEqual(0);
          expect(Number(y)).toBeGreaterThanOrEqual(0);
          expect(Number(x)).toBeLessThan(size);
          expect(Number(y)).toBeLessThan(size);
        }
      }
    }
  });
});
