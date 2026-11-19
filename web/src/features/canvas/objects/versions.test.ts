import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `elementsOf` reads Mermaid's DOM ids, which are not a public API, and the
 * shape of PlantUML's SVG. `e2e/canvas.objects.spec.ts` pins what it reads
 * against exactly these versions. Changing one is fine; doing it without
 * re-running that spec is how anchors break silently.
 */
describe('the diagram renderers', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
  );
  it('are pinned to the versions the anchor spec was written against', () => {
    expect(pkg.dependencies.mermaid).toBe('12.3.0');
    expect(pkg.dependencies['@plantuml/core']).toBe('1.2026.9');
  });
});
