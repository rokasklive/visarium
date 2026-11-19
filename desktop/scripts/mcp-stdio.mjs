#!/usr/bin/env node
// Visarium's MCP endpoint for clients that only start servers over stdio,
// such as Claude Desktop (ADR-0031).
//
//   node mcp-stdio.mjs http://127.0.0.1:47821/mcp
//
// `/mcp` is stateless JSON-RPC over HTTP, so a bridge is one POST per line:
// each message read from stdin is posted, and each answer is written to stdout
// as one line. VISARIUM_TOKEN, when set, is sent as the bearer token a server
// deployment needs; the desktop app's own library needs none. Nothing but
// protocol goes to stdout: diagnostics go to stderr.

import { createInterface } from 'node:readline';

const url = process.argv[2];
if (!url) {
  console.error('usage: mcp-stdio.mjs <visarium url>/mcp');
  process.exit(2);
}
const headers = { 'content-type': 'application/json', accept: 'application/json' };
if (process.env.VISARIUM_TOKEN) headers.authorization = `Bearer ${process.env.VISARIUM_TOKEN}`;

const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function relay(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } });
  }
  const fail = (text) =>
    message.id !== undefined && reply({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-method': String(message.method ?? '') },
      body: line,
    });
    if (res.status === 202) return; // a notification: no answer
    const body = await res.text();
    if (!res.ok) {
      console.error(`visarium answered ${res.status}: ${body.slice(0, 300)}`);
      return fail(`Visarium answered ${res.status}: ${body.slice(0, 300)}`);
    }
    process.stdout.write(`${body.trim()}\n`);
  } catch (error) {
    console.error(`visarium unreachable at ${url}: ${error}`);
    fail(`Visarium is not answering at ${url}. Is the app running, on this port?`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) void relay(line);
});
