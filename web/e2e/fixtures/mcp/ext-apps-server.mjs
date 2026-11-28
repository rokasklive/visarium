// An MCP server with three official MCP Apps examples' views and tools, for
// canvas.apps.ext-apps.spec.ts (canvas/app-sources):
//
//   node web/e2e/fixtures/mcp/ext-apps-server.mjs PORT
//
// The views are the examples' own built HTML, unchanged, from
// fetch-ext-apps.sh. The tools answer as the examples' servers do; their data
// is adapted from modelcontextprotocol/ext-apps (MIT, Copyright Anthropic,
// PBC), examples basic-server-vanillajs, budget-allocator-server and
// cohort-heatmap-server, trimmed to what the views read.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const port = Number(process.argv[2] ?? 18792);
const cache = new URL('../../../node_modules/.cache/ext-apps/', import.meta.url);
const view = (name) => readFileSync(new URL(`${name}.html`, cache), 'utf8');
const MIME = 'text/html;profile=mcp-app';

// --- budget-allocator ---------------------------------------------------------
const CATEGORIES = [
  { id: 'marketing', name: 'Marketing', color: '#3b82f6', defaultPercent: 25 },
  { id: 'engineering', name: 'Engineering', color: '#10b981', defaultPercent: 35 },
  { id: 'operations', name: 'Operations', color: '#f59e0b', defaultPercent: 15 },
  { id: 'sales', name: 'Sales', color: '#ef4444', defaultPercent: 15 },
  { id: 'rd', name: 'R&D', color: '#8b5cf6', defaultPercent: 10 },
];
const bench = (m, e, o, s, r) => ({
  marketing: { p25: m - 5, p50: m, p75: m + 5 },
  engineering: { p25: e - 5, p50: e, p75: e + 5 },
  operations: { p25: o - 4, p50: o, p75: o + 4 },
  sales: { p25: s - 5, p50: s, p75: s + 5 },
  rd: { p25: r - 4, p50: r, p75: r + 4 },
});
function budget() {
  const history = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 10 - i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    history.push({
      month,
      allocations: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultPercent])),
    });
  }
  return {
    config: {
      categories: CATEGORIES,
      presetBudgets: [50000, 100000, 250000, 500000],
      defaultBudget: 100000,
      currency: 'USD',
      currencySymbol: '$',
    },
    analytics: {
      history,
      benchmarks: [
        { stage: 'Seed', categoryBenchmarks: bench(20, 47, 12, 15, 10) },
        { stage: 'Series A', categoryBenchmarks: bench(25, 40, 14, 20, 12) },
        { stage: 'Series B', categoryBenchmarks: bench(27, 35, 16, 23, 12) },
        { stage: 'Growth', categoryBenchmarks: bench(30, 30, 18, 25, 8) },
      ],
      stages: ['Seed', 'Series A', 'Series B', 'Growth'],
      defaultStage: 'Series A',
    },
  };
}

// --- cohort-heatmap -------------------------------------------------------------
function cohorts({
  metric = 'retention',
  periodType = 'monthly',
  cohortCount = 12,
  maxPeriods = 12,
} = {}) {
  const decay = { retention: 0.12, revenue: 0.1, active: 0.18 }[metric] ?? 0.12;
  const periods = [];
  const periodLabels = [];
  for (let i = 0; i < maxPeriods; i++) {
    periods.push(`M${i}`);
    periodLabels.push(`Month ${i}`);
  }
  const rows = [];
  for (let c = 0; c < cohortCount; c++) {
    const d = new Date(Date.UTC(2026, 10 - (cohortCount - 1 - c), 1));
    const originalUsers = 1000 + c * 250;
    const cells = [];
    for (let p = 0; p < Math.min(cohortCount - c, maxPeriods); p++) {
      const retention = p === 0 ? 1 : 0.75 * Math.exp(-decay * (p - 1)) + 0.08;
      cells.push({
        cohortIndex: c,
        periodIndex: p,
        retention,
        usersRetained: Math.round(originalUsers * retention),
        usersOriginal: originalUsers,
      });
    }
    rows.push({
      cohortId: d.toISOString().slice(0, 7),
      cohortLabel: d.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      originalUsers,
      cells,
    });
  }
  return {
    cohorts: rows,
    periods,
    periodLabels,
    metric,
    periodType,
    generatedAt: new Date().toISOString(),
  };
}

const TOOLS = [
  {
    name: 'get-time',
    title: 'Get Time',
    description: 'Returns the current server time as an ISO 8601 string.',
    inputSchema: { type: 'object' },
    _meta: { ui: { resourceUri: 'ui://get-time/mcp-app.html' } },
    view: 'basic-vanillajs',
    call: () => {
      const time = new Date().toISOString();
      return { content: [{ type: 'text', text: time }], structuredContent: { time } };
    },
  },
  {
    name: 'get-budget-data',
    title: 'Get Budget Data',
    description: 'Budget configuration, history and benchmarks.',
    inputSchema: { type: 'object' },
    _meta: { ui: { resourceUri: 'ui://budget-allocator/mcp-app.html' } },
    view: 'budget-allocator',
    call: () => ({ content: [{ type: 'text', text: 'Budget data' }], structuredContent: budget() }),
  },
  {
    name: 'get-cohort-data',
    title: 'Get Cohort Retention Data',
    description: 'Cohort retention heatmap data.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['retention', 'revenue', 'active'] },
        periodType: { type: 'string', enum: ['monthly', 'weekly'] },
        cohortCount: { type: 'number' },
        maxPeriods: { type: 'number' },
      },
    },
    _meta: { ui: { resourceUri: 'ui://get-cohort-data/mcp-app.html' } },
    view: 'cohort-heatmap',
    call: (args) => {
      const data = cohorts(args);
      return {
        content: [{ type: 'text', text: `${data.cohorts.length} cohorts` }],
        structuredContent: data,
      };
    },
  },
];

function server() {
  const s = new Server(
    { name: 'ext-apps-examples', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ view: _v, call: _c, ...t }) => t),
  }));
  s.setRequestHandler(CallToolRequestSchema, async (r) => {
    const t = TOOLS.find((x) => x.name === r.params.name);
    if (!t) return { isError: true, content: [{ type: 'text', text: 'no such tool' }] };
    return t.call(r.params.arguments ?? {});
  });
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: TOOLS.map((t) => ({ uri: t._meta.ui.resourceUri, name: t.title, mimeType: MIME })),
  }));
  s.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    const t = TOOLS.find((x) => x._meta.ui.resourceUri === r.params.uri);
    if (!t) throw new Error(`no resource ${r.params.uri}`);
    return { contents: [{ uri: r.params.uri, mimeType: MIME, text: view(t.view) }] };
  });
  return s;
}

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
  .listen(port, '127.0.0.1', () => console.log(`ext-apps examples on ${port}`));
