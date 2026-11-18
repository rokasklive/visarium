/**
 * Invariants 1 and 2, as a test rather than a promise.
 *
 * canvas-core must never import React, Konva or the DOM. A lint rule would be
 * easy to disable in a hurry; a failing test is harder to talk past.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = ['react', 'react-dom', 'konva', 'react-konva', 'zustand'];

const sourceFiles = readdirSync(import.meta.dirname)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(import.meta.dirname, f));

describe('canvas-core dependency boundary', () => {
  it('has source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  for (const file of sourceFiles) {
    it(`${file} imports no renderer or UI package`, () => {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
      for (const specifier of imports) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : (specifier.split('/')[0] as string);
        expect(FORBIDDEN, `${file} imports ${specifier}`).not.toContain(pkg);
      }
    });
  }

  it('declares no forbidden runtime dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(FORBIDDEN).not.toContain(name);
    }
  });
});
