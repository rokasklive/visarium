import { describe, expect, it } from 'vitest';
import { onBothGrids, wordmarkLayout } from './wordmark';

describe('wordmark', () => {
  it('is the 260 dots of "Visarium" in the face', () => {
    // Counted from the font itself at 1000px. A changed map is a changed logo.
    const { rowPaths } = wordmarkLayout(1);
    expect(rowPaths.join('').match(/M/g)).toHaveLength(260);
  });

  it("puts every dot on whole device pixels, at about the face's 32px size", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const { pitch, dot, rowPaths } = wordmarkLayout(dpr);
      expect(rowPaths.join('')).not.toMatch(/\./);
      expect(Math.abs(pitch / dpr - 2.88)).toBeLessThan(0.5);
      expect(dot).toBeGreaterThanOrEqual(pitch - dot);
    }
    expect(wordmarkLayout(1)).toMatchObject({ pitch: 3, dot: 2 });
  });

  it('finds the pixel that is whole in CSS and on the device', () => {
    expect(onBothGrids(4.8, 1.25)).toBe(4); // 5 device px
    expect(onBothGrids(4.5, 2)).toBe(5);
    expect(onBothGrids(21.2, 2.5, true)).toBe(22); // 55 device px
    expect(onBothGrids(7.3, 1)).toBe(7);
  });
});
