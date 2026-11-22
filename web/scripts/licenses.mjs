// Writes public/licenses.txt: Visarium's own licence, then the notices of every
// third-party work that ships inside it (Rust crates in the server and desktop
// binaries, npm packages in the web bundle, fonts). The MIT, BSD and Apache
// licences require those notices to travel with the binaries; the file is
// embedded in the bundle and linked from Settings ▸ About.
//
//   node scripts/licenses.mjs          regenerate
//   node scripts/licenses.mjs --check  fail if the committed file is stale
//
// Committed rather than built, because the image builds the web bundle in a
// stage with no Rust toolchain.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const out = join(import.meta.dirname, '..', 'public', 'licenses.txt');
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;
const rule = '='.repeat(78);

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

function texts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      // A LICENSES/ directory (REUSE layout) holds one file per licence.
      e.isDirectory() ? texts(join(dir, e.name)) : [readFileSync(join(dir, e.name), 'utf8').trim()],
    );
}

/** Crates the shipped binaries link: normal and build dependencies, not dev. */
function crates() {
  const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked']));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [...meta.workspace_members];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind !== 'dev')) stack.push(dep.pkg);
    }
  }
  return meta.packages
    .filter((p) => seen.has(p.id) && !meta.workspace_members.includes(p.id))
    .map((p) => ({
      name: p.name,
      license: p.license ?? (p.license_file ? 'see licence text' : 'unspecified'),
      url: p.repository ?? p.homepage ?? '',
      texts: texts(join(p.manifest_path, '..')),
    }));
}

/** npm packages the web bundle ships: production dependencies only. */
function packages() {
  const list = JSON.parse(
    run('pnpm', ['--filter', '@visarium/web', 'licenses', 'list', '--prod', '--json']),
  );
  return Object.values(list)
    .flat()
    .filter((p) => !p.name.startsWith('@visarium/'))
    .flatMap((p) =>
      p.versions.map((version, i) => ({
        name: p.name,
        license: p.license,
        url: p.homepage ?? '',
        texts: texts(p.paths[i]),
      })),
    );
}

const fonts = [
  {
    name: 'Departure Mono',
    license: 'OFL-1.1',
    url: 'https://departuremono.com',
    texts: [readFileSync(join(root, 'web/public/fonts/departure-mono-LICENSE.txt'), 'utf8').trim()],
  },
  {
    // ponytail: no licence file shipped with it; its author's terms are free use.
    name: 'Edit Undo Dot BRK 2.64',
    license: 'freeware, by Brian Kent (Ænigma Fonts)',
    url: 'https://www.dafont.com/edit-undo.font',
    texts: [],
  },
];

// Hundreds of packages ship word-for-word the same Apache or MIT text; each
// distinct text is printed once, at the end, and referred to by number.
const distinct = new Map();
const ref = (text) => {
  const key = text.replace(/\s+/g, ' ');
  if (!distinct.has(key)) distinct.set(key, { n: distinct.size + 1, text });
  return `[${distinct.get(key).n}]`;
};

/**
 * One entry per package, whatever versions of it ship: a notice needs the
 * work, its licence and its text, not the version, and leaving versions out
 * keeps a dependency bump from making this file stale.
 */
function byName(works) {
  const merged = new Map();
  for (const w of works) {
    const m = merged.get(w.name);
    if (!m) merged.set(w.name, { ...w, texts: [...w.texts] });
    else {
      if (!m.license.split(' / ').includes(w.license)) m.license += ` / ${w.license}`;
      for (const t of w.texts) if (!m.texts.includes(t)) m.texts.push(t);
    }
  }
  return [...merged.values()];
}

function section(title, works) {
  const sorted = byName(works).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [rule, title, rule, ''];
  for (const w of sorted) {
    lines.push(`${w.name} — ${w.license}${w.url ? ` — ${w.url}` : ''}`);
    lines.push(
      w.texts.length
        ? `    licence text ${w.texts.map(ref).join(' ')}`
        : '    (no licence file in the package; licence as named above)',
    );
  }
  return lines.join('\n');
}

function appendix() {
  const lines = [rule, 'Licence texts', rule];
  for (const { n, text } of distinct.values()) lines.push('', `[${n}]`, '', text);
  return lines.join('\n');
}

const file = [
  // A byte-order mark: the server sends text/plain with no charset, and
  // browsers then read "Kučinskas" as Latin-1 unless the file says otherwise.
  '﻿Visarium',
  'Copyright © 2026 Rokas Kučinskas',
  '',
  'This program is free software: you can redistribute it and/or modify it under',
  'the terms of the GNU Affero General Public License, version 3 only, as published',
  'by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY; without',
  'even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.',
  'The full licence follows; third-party notices come after it.',
  '',
  readFileSync(join(root, 'LICENSE'), 'utf8').trim(),
  '',
  section('Rust crates (server and desktop app)', crates()),
  section('npm packages (web app)', packages()),
  section('Fonts', fonts),
  '',
  appendix(),
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== file) {
    console.error('licenses: public/licenses.txt is stale; run `just licenses`');
    process.exit(1);
  }
} else {
  writeFileSync(out, file);
  console.log(`licenses: wrote ${out} (${(file.length / 1024).toFixed(0)} KiB)`);
}
