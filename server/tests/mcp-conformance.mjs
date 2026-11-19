// The server's /mcp, driven by the official MCP TypeScript SDK client
// (ADR-0031, design D1). The endpoint is hand-written, so drift from what
// real clients send fails here rather than in someone's agent.
//
//   node server/tests/mcp-conformance.mjs http://127.0.0.1:PORT/mcp [token]
//
// `just mcp-conformance` starts a throwaway single-user server and runs it.

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, token] = process.argv.slice(2);
if (!url) {
  console.error('usage: mcp-conformance.mjs <url> [token]');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
});
const client = new Client({ name: 'visarium-conformance', version: '1.0.0' });
await client.connect(transport);

const info = client.getServerVersion();
assert.equal(info?.name, 'visarium');
assert.match(client.getInstructions() ?? '', /describes/);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, [
  'arrange', 'board_read', 'changes', 'desk', 'group_create', 'item_create', 'item_delete', 'item_edit',
  'item_read', 'item_view', 'link', 'search', 'tasks', 'trace', 'unlink',
]);

const desk = await client.callTool({ name: 'desk', arguments: {} });
assert.equal(desk.isError, false);
assert.equal(desk.content[0].type, 'text');

const missing = await client.callTool({ name: 'board_read', arguments: { board: 'No such board' } });
assert.equal(missing.isError, true, 'a tool failure is a result, not a protocol error');

const { contents } = await client.readResource({ uri: 'visarium://guide' });
assert.match(contents[0].text, /Example calls/);

await client.close();
console.log(`ok: ${names.length} tools, instructions, a call, a tool error and the guide, through the official client`);

// --- the 2026-07-28 multi-round-trip confirmation, on the wire ----------------
// The SDK client above speaks an older revision, so this part is raw JSON-RPC:
// per-request capabilities in `_meta`, an `input_required` answer, and a retry
// carrying `params.inputResponses`. It needs the *Manage boards* grant, which
// a throwaway single-user server gives its local agents through the API.
const origin = new URL(url).origin;
const auth = token ? { Authorization: `Bearer ${token}` } : {};
if (!token) {
  const session = await fetch(`${origin}/api/session`);
  const xsrf = /XSRF-TOKEN=([^;]+)/.exec(session.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(xsrf, 'the server issues a CSRF cookie');
  const grant = await fetch(`${origin}/api/agent-settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `XSRF-TOKEN=${xsrf}`, 'X-XSRF-TOKEN': xsrf },
    body: JSON.stringify({ localAgentsManageBoards: true }),
  });
  assert.equal(grant.status, 200, await grant.text());

  let id = 10;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'visarium-conformance', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  };
  const rpc = async (params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Method': 'tools/call', ...auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { _meta: meta, ...params } }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).result;
  };
  const made = await rpc({ name: 'board_create', arguments: { title: 'Conformance' } });
  assert.equal(made.isError, false, JSON.stringify(made));
  const call = { name: 'board_delete', arguments: { board: 'Conformance' } };
  const ask = await rpc(call);
  assert.equal(ask.resultType, 'input_required');
  assert.equal(ask.inputRequests.confirm_delete.method, 'elicitation/create');
  const done = await rpc({
    ...call,
    inputResponses: { confirm_delete: { action: 'accept', content: { confirm: true } } },
  });
  assert.equal(done.isError, false, JSON.stringify(done));
  assert.match(done.content[0].text, /^Deleted the board "Conformance"/);
  console.log('ok: board_create, then board_delete asked input_required and deleted on the retry');
}
