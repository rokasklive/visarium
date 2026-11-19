// Proof that a production bundle carries no developer tools (spec:
// canvas/inspector). Every file under dist/ is searched for the inspector's
// marker; one hit fails the build.
//
//   node scripts/check-bundle.mjs                     a production build: marker must be absent
//   node scripts/check-bundle.mjs --expect-inspector  a dev build: marker must be present
//
// The second form exists so the check itself is tested: a search that can
// never find anything proves nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'visarium-inspector';
const dist = join(import.meta.dirname, '..', 'dist');
const expectInspector = process.argv.includes('--expect-inspector');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let all;
try {
  all = [...files(dist)];
} catch {
  console.error(`check-bundle: no ${dist}; build first`);
  process.exit(2);
}
const hits = all.filter((f) => readFileSync(f).includes(MARKER));
if (expectInspector) {
  if (hits.length === 0) {
    console.error('check-bundle: expected the inspector in this build and found none');
    process.exit(1);
  }
  console.log(`check-bundle: inspector present (${hits.length} file(s)), as a dev build should be`);
} else {
  if (hits.length > 0) {
    console.error(
      `check-bundle: the production bundle contains the inspector:\n  ${hits.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(`check-bundle: ${all.length} files, no inspector`);
}
