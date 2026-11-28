// A local MCP server for the canvas-apps e2e (canvas/app-sources), on the
// official SDK over Streamable HTTP, stateless:
//
//   node web/e2e/fixtures/mcp/server.mjs PORT
//   node web/e2e/fixtures/mcp/server.mjs --stdio   (a local server, as the desktop runs one)
//
// - quote: priced from { age }, with a view (ui://quote/view) that shows the
//   result and has buttons calling the server's tools from inside the view.
// - roll: a tool the view may call.
// - secret: a tool only the model may call; the board must refuse the view.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const stdio = process.argv[2] === '--stdio';
const port = Number(process.argv[2] ?? 18790);
const view = readFileSync(new URL('./quote-view.html', import.meta.url), 'utf8');
const TOOLS = [
  {
    name: 'quote',
    title: 'Insurance quote',
    description: 'Prices a policy from the insured age.',
    inputSchema: { type: 'object', properties: { age: { type: 'number' } } },
    _meta: { ui: { resourceUri: 'ui://quote/view' } },
  },
  { name: 'roll', description: 'A die.', inputSchema: { type: 'object' } },
  {
    name: 'secret',
    description: 'For the model only.',
    inputSchema: { type: 'object' },
    _meta: { ui: { visibility: ['model'] } },
  },
];

function server() {
  const s = new Server(
    { name: 'visarium-e2e', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (r) => {
    const { name, arguments: args = {} } = r.params;
    if (name === 'quote') {
      const premium = Number(args.age ?? 0) * 30;
      return {
        content: [{ type: 'text', text: `Premium ${premium}` }],
        structuredContent: { premium },
      };
    }
    if (name === 'roll')
      return { content: [{ type: 'text', text: '4' }], structuredContent: { value: 4 } };
    return { content: [{ type: 'text', text: 'secret' }], structuredContent: { secret: true } };
  });
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'ui://quote/view', name: 'Quote', mimeType: 'text/html;profile=mcp-app' }],
  }));
  s.setRequestHandler(ReadResourceRequestSchema, async (r) => ({
    contents: [{ uri: r.params.uri, mimeType: 'text/html;profile=mcp-app', text: view }],
  }));
  return s;
}

if (stdio) await server().connect(new StdioServerTransport());
else
  http
    .createServer(async (req, res) => {
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const s = server();
      res.on('close', () => {
        void transport.close();
        void s.close();
      });
      await s.connect(transport);
      await transport.handleRequest(req, res, body);
    })
    .listen(port, '127.0.0.1', () => console.log(`mcp e2e server on ${port}`));
