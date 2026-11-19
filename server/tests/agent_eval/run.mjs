// The agent eval (agent-access tasks 9.x): each task in tasks.json, run by
// Claude Code against a fresh copy of the fixture board on a running server,
// checked against the answer or the board it leaves, with tool calls, tool
// errors and tokens recorded.
//
//   node server/tests/agent_eval/run.mjs http://127.0.0.1:PORT [--model M] [--only id,id] [--label name]
//
// `just agent-eval` starts a throwaway single-user server and runs it.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const base = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
if (!base) {
  console.error('usage: run.mjs <server url> [--model M] [--only id,id] [--label name]');
  process.exit(2);
}
const only = opt('only')?.split(',');
const label = opt('label') ?? 'run';
const eval_ = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'offline-sync.json'), 'utf8'));

// --- the server, over REST (seeding) and /mcp (checking) ----------------------

let cookies = '';
let xsrf = '';
async function rest(method, path, body, contentType = 'application/json') {
  const headers = { cookie: cookies, 'x-xsrf-token': xsrf };
  if (body !== undefined) headers['content-type'] = contentType;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k === 'XSRF-TOKEN') xsrf = v;
    cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${k}=`)), pair].join('; ');
  }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function mcp(name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  return body.result?.content?.[0]?.text ?? '';
}

/** A fresh "Offline sync": any older one deleted, the fixture applied. Returns its revision. */
async function seed() {
  await rest('GET', '/api/session');
  for (const b of await rest('GET', '/api/boards')) {
    if (b.title === fixture.title) await rest('DELETE', `/api/boards/${b.id}`);
  }
  const board = await rest('POST', '/api/boards', { title: fixture.title });
  const png = readFileSync(join(here, '..', '..', '..', 'web', 'public', 'bench', 'ref-1.png'));
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'whiteboard-photo.png');
  const res = await fetch(`${base}/api/assets`, { method: 'POST', headers: { cookie: cookies, 'x-xsrf-token': xsrf }, body: form });
  const asset = await res.json();
  let ops = JSON.stringify(fixture.operations).replaceAll('{{ASSET}}', asset.id);
  for (const fixed of new Set(ops.match(/00000000-0000-4000-8000-\d{12}/g))) ops = ops.replaceAll(fixed, crypto.randomUUID());
  const applied = await rest('POST', `/api/boards/${board.id}/operations`, {
    operations: JSON.parse(ops).map((body) => ({ operationId: crypto.randomUUID(), baseRevision: 0, body })),
  });
  return { board, revision: applied.revision, ops: JSON.parse(ops) };
}

/** A 300-line note whose answer sits near line 230, for the read-window variants. */
async function longNote(seeded) {
  const lines = ['# Sync protocol notes', ''];
  for (let n = 1; lines.length < 228; n++) lines.push(`- Note ${n}: frames are idempotent by operation id; nothing here sets a limit.`);
  lines.push('', '## Retry limits', 'Retries stop after 7 attempts. Backoff doubles from 1 s and is capped at 45 s.', '');
  while (lines.length < 300) lines.push(`- Trailer ${lines.length}: unrelated detail.`);
  await rest('POST', `/api/boards/${seeded.board.id}/operations`, {
    operations: [{ operationId: crypto.randomUUID(), baseRevision: 0, body: {
      type: 'item.create', itemId: crypto.randomUUID(), z: 50,
      transform: { x: 3000, y: 0, width: 320, height: 900, rotation: 0 },
      content: { kind: 'note', source: lines.join('\n') } } }],
  });
}

/** For the catch-up task: something happens after the baseline. */
async function changeSince(seeded) {
  const c1 = seeded.ops.find((o) => o.content?.kind === 'checklist').itemId;
  await rest('POST', `/api/boards/${seeded.board.id}/operations`, {
    operations: [{ operationId: crypto.randomUUID(), baseRevision: 0, body: { type: 'task.set', itemId: c1, taskId: 't5', state: 'doing' } }],
  });
}

// --- checks -------------------------------------------------------------------

async function check(task, answer) {
  const c = task.check;
  const fails = [];
  if (c.kind === 'answer_mentions') {
    for (const s of c.all) if (!answer.includes(s)) fails.push(`answer does not mention ${s}`);
    return fails;
  }
  const overview = await mcp('board_read', { board: fixture.title });
  if (c.no_broken_links && / broken/.test(overview.split('\n')[0])) fails.push('the board still has broken links');
  if (c.max_broken_links !== undefined) {
    const broken = Number(/ (\d+) broken/.exec(overview.split('\n')[0])?.[1] ?? 0);
    if (broken > c.max_broken_links) fails.push(`${broken} broken links, more than the ${c.max_broken_links} the board started with`);
  }
  for (const [ref, names] of Object.entries(c.diagram_declares ?? {})) {
    const read = await mcp('item_read', { board: fixture.title, ref });
    const line = read.split('\n').find((l) => l.startsWith('Elements')) ?? '';
    for (const n of names) if (!new RegExp(`\\b${n}\\b`).test(line)) fails.push(`${ref} does not declare ${n}`);
  }
  for (const [task_, state] of Object.entries(c.task_state ?? {})) {
    const [ref] = task_.split('/');
    const read = await mcp('item_read', { board: fixture.title, ref });
    if (!read.includes(`${task_} [${state}]`)) fails.push(`${task_} is not ${state}`);
  }
  if (c.new_checklist_linked) {
    const { type, to } = c.new_checklist_linked;
    const ok = overview.split('\n').some((l, i, all) => /^c([2-9]|\d\d)\s/.test(l) && (all[i + 1] ?? '').includes(`→ ${type} ${to}`));
    if (!ok) fails.push(`no new checklist that ${type} ${to}`);
  }
  return fails;
}

// --- one task through Claude Code ------------------------------------------------

function runClaude(prompt, mcpConfig, cwd) {
  const cli = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__visarium', '--max-turns', '40'];
  if (opt('model')) cli.push('--model', opt('model'));
  return new Promise((resolve) => {
    const child = spawn('claude', cli, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve(`{"type":"error","message":${JSON.stringify(String(e))}}`));
    child.on('close', (code) => {
      if (code !== 0 && err) console.error(`\nclaude exited ${code}: ${err.slice(0, 500)}`);
      resolve(out);
    });
  });
}

function measure(stream) {
  let calls = 0;
  let errors = 0;
  const names = {};
  let result = {};
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of ev.message?.content ?? []) {
      if (part.type === 'tool_use') {
        calls += 1;
        const n = part.name.replace('mcp__visarium__', '');
        names[n] = (names[n] ?? 0) + 1;
      }
      if (part.type === 'tool_result' && part.is_error) errors += 1;
    }
    if (ev.type === 'result') result = ev;
  }
  const u = result.usage ?? {};
  return {
    answer: result.result ?? '',
    calls,
    toolErrors: errors,
    tools: names,
    turns: result.num_turns,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: result.total_cost_usd,
    seconds: Math.round((result.duration_ms ?? 0) / 1000),
  };
}

// --- the run ------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'visarium-eval-'));
const mcpConfig = join(work, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { visarium: { type: 'http', url: `${base}/mcp` } } }));
try {
  execFileSync('claude', ['--version']);
} catch {
  console.error('Claude Code (`claude`) is not on PATH');
  process.exit(2);
}

const results = [];
for (const task of eval_.tasks.filter((t) => !only || only.includes(t.id))) {
  const seeded = await seed();
  let prompt = task.prompt;
  if (task.extra === 'long-note') await longNote(seeded);
  if (prompt.includes('{{BASELINE}}')) {
    prompt = prompt.replace('{{BASELINE}}', String(seeded.revision));
    await changeSince(seeded);
  }
  process.stdout.write(`${task.id} … `);
  const stream = await runClaude(prompt, mcpConfig, work);
  // The whole transcript, kept beside the results for reading.
  mkdirSync(join(here, 'results', 'transcripts'), { recursive: true });
  writeFileSync(join(here, 'results', 'transcripts', `${label}-${task.id}.jsonl`), stream);
  const m = measure(stream);
  if (/Failed to authenticate|OAuth access token has expired|Invalid API key/.test(m.answer)) {
    console.error(`\nClaude Code is not signed in (${m.answer.trim()}). Run \`claude\` and /login, then try again.`);
    process.exit(2);
  }
  // A run cut off by a usage limit measures nothing: stop rather than record it.
  if (m.calls === 0 && /hit your (session|usage) limit|rate limit/i.test(m.answer)) {
    console.error(`\nClaude Code stopped: ${m.answer.trim()}. This run is incomplete; try again later.`);
    process.exit(2);
  }
  const fails = await check(task, m.answer);
  const row = { id: task.id, ok: fails.length === 0, fails, ...m };
  results.push(row);
  console.log(`${row.ok ? 'pass' : 'FAIL'} · ${m.calls} calls · ${m.toolErrors} tool errors · ${m.inputTokens} in / ${m.outputTokens} out${fails.length ? ` · ${fails.join('; ')}` : ''}`);
}

const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${label}-${new Date().toISOString().replaceAll(':', '-')}.json`);
writeFileSync(file, JSON.stringify({ label, model: opt('model') ?? 'default', results }, null, 2));
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · ${results.reduce((a, r) => a + r.calls, 0)} calls · ${results.reduce((a, r) => a + r.toolErrors, 0)} tool errors · results in ${file}`);
process.exit(passed === results.length ? 0 : 1);
