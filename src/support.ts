#!/usr/bin/env node
/**
 * Support MCP server. The public face of the Orgo support agent, and the only
 * thing Fin connects to.
 *
 * Endpoints:
 *   GET  /healthz   — liveness, fact count, active source SHA
 *   GET  /metrics   — Prometheus text format
 *   POST /mcp       — JSON-RPC over Streamable HTTP
 *
 * This entry point is deliberately standalone. It does NOT import `server.ts`,
 * `lib/client.ts` or `auth/oauth.ts`, because importing any of them would pull
 * an Orgo API client into a process that is reachable from a public chat
 * conversation. `npm run check:support-isolation` asserts that property against
 * the built bundle rather than trusting review to catch a future import.
 *
 * What this process can disclose is bounded by what it holds: a list of short
 * customer-safe answers with no citations, no file paths and no code, produced
 * by `scripts/build-facts.ts`. No prompt can extract a field that was never
 * loaded into memory.
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { FactsIndex, loadFacts } from './lib/facts-index.js';
import { registerSupportTools } from './tools/support.js';
import { createLogger } from './lib/logger.js';
import { Counter, Gauge } from './lib/metrics.js';
import { VERSION } from './lib/version.js';

const log = createLogger('orgo-support-mcp');

/**
 * Support-specific metrics, built from the shared primitives rather than reusing
 * the `Metrics` aggregate: that one carries OAuth and session-hijack counters
 * which are meaningless here, and exporting them would imply this server has an
 * OAuth path. It does not.
 */
const queryCount = new Counter('orgo_support_queries_total', 'Fact queries, by whether anything matched.');
const rateLimited = new Counter('orgo_support_rate_limited_total', 'Requests rejected by the rate limiter.');
const authFailures = new Counter('orgo_support_auth_failures_total', 'Requests with a missing or wrong bearer.');
const factsLoaded = new Gauge('orgo_support_facts_loaded', 'Number of behaviour facts in the served index.');

function renderMetrics(): string {
  return (
    [queryCount.render(), rateLimited.render(), authFailures.render(), factsLoaded.render()].join('\n\n') + '\n'
  );
}

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const FACTS_PATH = process.env.FACTS_PATH ?? '/app/facts.serve.json';
const BEARER = process.env.SUPPORT_BEARER ?? '';
const SOURCE_SHA = process.env.SOURCE_SHA ?? 'unknown';

/**
 * Requests per minute for the single connector.
 *
 * This is not capacity planning. Fin's legitimate traffic is one call per
 * unanswered question; a rate this high can only be probing, and probing is the
 * realistic way to sample an index that cannot be enumerated.
 */
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);

if (!BEARER) {
  console.error('SUPPORT_BEARER is required. Refusing to start an unauthenticated support server.');
  process.exit(1);
}

const facts = loadFacts(FACTS_PATH, (p) => readFileSync(p, 'utf8'), existsSync);
const index = new FactsIndex(facts);
factsLoaded.set(index.size);
log.info('facts_loaded', { count: index.size, path: FACTS_PATH, sourceSha: SOURCE_SHA });

const app = express();
app.use(express.json({ limit: '256kb' }));

/** Constant-time bearer comparison, so a wrong token cannot be found by timing. */
function bearerValid(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(BEARER);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

const window = { startedAt: Date.now(), count: 0 };

function requireBearer(req: Request, res: Response, next: NextFunction): void {
  if (!bearerValid(req.header('authorization'))) {
    authFailures.inc();
    log.warn('auth_failed', { ip: req.ip, path: req.path });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const now = Date.now();
  if (now - window.startedAt > 60_000) {
    window.startedAt = now;
    window.count = 0;
  }
  if (++window.count > RATE_LIMIT_PER_MIN) {
    rateLimited.inc();
    log.warn('rate_limited', { count: window.count });
    res.status(429).json({ error: 'rate limited' });
    return;
  }

  next();
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', facts: index.size, sourceSha: SOURCE_SHA });
});

app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(renderMetrics());
});

const transports = new Map<string, StreamableHTTPServerTransport>();

function buildSupportServer(): McpServer {
  const server = new McpServer(
    { name: 'orgo-support-mcp', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Verified facts about how the Orgo platform behaves. Use search_behavior_facts when the ' +
        'documentation does not answer an administrator question about product behaviour. ' +
        'An empty result means no verified fact covers the question: hand off to a human rather ' +
        'than inferring an answer. This server holds no customer or organisation data.',
    },
  );

  registerSupportTools(server, {
    index,
    onQuery: (query, resultCount) => {
      queryCount.inc({ matched: resultCount > 0 ? 'yes' : 'no' });
      // The query text is hashed, never logged. An administrator will type a
      // member's name into chat sooner or later, and that is personal data we
      // have no reason to retain. The hash still lets us spot a repeated probe.
      log.info('fact_query', {
        queryHash: createHash('sha256').update(query).digest('hex').slice(0, 12),
        terms: query.split(/\s+/).length,
        resultCount,
      });
    },
  });

  return server;
}

app.post('/mcp', requireBearer, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        log.info('session_initialized', { sessionId: id });
      },
    });

    transport.onclose = () => {
      const id = transport!.sessionId;
      if (id) {
        transports.delete(id);
        log.info('session_closed', { sessionId: id });
      }
    };

    await buildSupportServer().connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No session and no initialize request' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, HOST, () => {
  log.info('listening', { port: PORT, host: HOST, facts: index.size, sourceSha: SOURCE_SHA });
});
