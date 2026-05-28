#!/usr/bin/env node
/**
 * Hosted MCP server with Streamable HTTP transport + OAuth (delegated to Orgo).
 *
 * Designed to be deployed at one hostname (e.g. `mcp.{tenant}.orgo.space`) and
 * consumed by remote MCP clients: Claude.ai integrations, Gemini agent
 * connectors, OpenAI Responses API tool-use, custom agents, etc.
 *
 * Endpoints:
 *   GET  /                                           — landing JSON
 *   GET  /healthz                                    — health probe
 *   GET  /metrics                                    — Prometheus text format
 *   GET  /.well-known/oauth-protected-resource       — RFC 9728 (per-tenant)
 *   GET  /.well-known/oauth-authorization-server     — RFC 8414 (per-tenant, synthesized)
 *   POST /mcp                                        — JSON-RPC over Streamable HTTP
 *   GET  /mcp                                        — SSE stream (resumability)
 *   DEL  /mcp                                        — terminate session
 *
 * Auth: every `/mcp` request MUST carry `Authorization: Bearer <orgo-oauth-token>`.
 * The same token is forwarded to Orgo's REST API as the user's identity.
 *
 * Multi-tenancy: tenant is derived from the incoming `Host` header, validated
 * against a suffix allowlist (SSRF guard), then bound to the session at init.
 * Subsequent requests on that session must come from the same `sub` AND the
 * same tenant — or they're rejected with 403.
 *
 * See README.md "Mode 2" and lib/tenant.ts for the routing rules.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.js';
import type { OrgoConfig } from './config.js';
import { OrgoClient } from './lib/client.js';
import { OAuthValidator, type TokenIdentity } from './auth/oauth.js';
import { loadTenantResolverOptions, resolveTenant, type TenantContext } from './lib/tenant.js';
import { InMemorySessionStore, type SessionStore } from './lib/sessions.js';
import { Metrics } from './lib/metrics.js';
import { createLogger } from './lib/logger.js';

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    orgoIdentity?: TokenIdentity;
    orgoBearer?: string;
    orgoTenant?: TenantContext;
  }
}

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? '0.0.0.0';
const ORGO_AUTH_BASE_URL = (process.env.ORGO_AUTH_BASE_URL ?? 'https://app.orgo.space').replace(/\/$/, '');
const SCOPES = (process.env.ORGO_OAUTH_SCOPES ?? 'profile email groups roles').trim().split(/\s+/);
const REQUEST_TIMEOUT_MS = Number(process.env.ORGO_TIMEOUT_MS ?? 30_000);
const TRUST_PROXY_HOPS = Number(process.env.ORGO_TRUST_PROXY_HOPS ?? 1);
// Protocol used for OUTBOUND API calls to {tenantHost}/api/v1/*. Always https
// in production; http is allowed only for local smoke tests against a mock.
const DOWNSTREAM_PROTOCOL: 'http' | 'https' =
  process.env.ORGO_DOWNSTREAM_PROTOCOL === 'http' ? 'http' : 'https';

const log = createLogger();
const metrics = new Metrics();
const tenantOptions = loadTenantResolverOptions();
const oauth = new OAuthValidator({ orgoAuthBaseUrl: ORGO_AUTH_BASE_URL, scopes: SCOPES });
const sessions: SessionStore = new InMemorySessionStore();
const transports = new Map<string, StreamableHTTPServerTransport>();

const app = express();
// Trust exactly N proxies in front (default 1 — Caddy or ALB). Trusting `true`
// is too permissive: it lets any X-Forwarded-For spoof the client IP.
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(express.json({ limit: '4mb' }));

function buildTenantConfig(tenantHost: string, bearer: string): OrgoConfig {
  return {
    tenantHost,
    protocol: DOWNSTREAM_PROTOCOL,
    baseUrl: `${DOWNSTREAM_PROTOCOL}://${tenantHost}`,
    timeoutMs: REQUEST_TIMEOUT_MS,
    auth: { kind: 'oauth', token: bearer },
  };
}

// ─── CORS ───────────────────────────────────────────────────────────────────
// Wildcard origin is safe with bearer auth: CORS protects implicit credentials
// (cookies), not explicit `Authorization` headers. Locking to a fixed origin
// list would block valid agents we don't know about yet.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, www-authenticate');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ─── Request observability ──────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { path: routeLabel(req.path), method: req.method };
    metrics.requestsTotal.inc({ ...labels, status: String(res.statusCode) });
    metrics.requestDuration.observe(labels, seconds);
  });
  next();
});

// Map path to a low-cardinality label. Keeps Prometheus series count finite.
function routeLabel(path: string): string {
  if (path.startsWith('/.well-known/')) return path;
  if (path === '/mcp' || path.startsWith('/mcp/')) return '/mcp';
  if (path === '/healthz' || path === '/metrics' || path === '/') return path;
  return 'other';
}

// ─── Public, unauthenticated endpoints ──────────────────────────────────────
app.get('/', (req, res) => {
  const ctx = resolveTenantOr400(req, res, { silent: true });
  res.json({
    name: 'orgo-mcp',
    version: '0.1.0',
    description: 'Hosted Model Context Protocol server for the Orgo API.',
    tenant: ctx?.tenantHost ?? null,
    publicBaseUrl: ctx?.publicBaseUrl ?? null,
    mcp: { transport: 'streamable-http', endpoint: '/mcp' },
    docs: 'https://orgo.space/docs/api-reference',
  });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size() });
});

app.get('/metrics', (_req, res) => {
  metrics.activeSessions.set(sessions.size());
  res.type('text/plain; version=0.0.4').send(metrics.render());
});

// OAuth metadata — both per-tenant. Same validator, different publicBaseUrl.
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const ctx = resolveTenantOr400(req, res);
  if (!ctx) return;
  res.json(oauth.protectedResourceMetadata(ctx.publicBaseUrl));
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const ctx = resolveTenantOr400(req, res);
  if (!ctx) return;
  res.json(oauth.authorizationServerMetadata(ctx.publicBaseUrl));
});

// ─── Bearer auth middleware ─────────────────────────────────────────────────
async function requireBearerAndTenant(req: Request, res: Response, next: NextFunction) {
  const ctx = resolveTenantOr400(req, res);
  if (!ctx) return;

  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    unauthorized(res, ctx, 'missing_token');
    return;
  }
  const bearer = match[1].trim();
  let identity: TokenIdentity | null;
  try {
    identity = await oauth.validate(bearer);
  } catch (e) {
    metrics.oauthValidations.inc({ result: 'error' });
    log.error('oauth_validate_unexpected_error', { error: (e as Error).message });
    res.status(502).json({ error: 'oauth_validate_failed' });
    return;
  }
  if (!identity) {
    metrics.oauthValidations.inc({ result: 'invalid' });
    unauthorized(res, ctx, 'invalid_token');
    return;
  }
  metrics.oauthValidations.inc({ result: 'ok' });

  req.orgoTenant = ctx;
  req.orgoBearer = bearer;
  req.orgoIdentity = identity;
  next();
}

function unauthorized(res: Response, ctx: TenantContext, error: 'missing_token' | 'invalid_token') {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="orgo-mcp", error="${error}", resource_metadata="${ctx.publicBaseUrl}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({
    error,
    error_description:
      error === 'missing_token'
        ? 'Authorization: Bearer <orgo-oauth-token> required.'
        : 'The presented bearer token did not validate against Orgo userinfo.',
  });
}

function resolveTenantOr400(req: Request, res: Response, opts: { silent?: boolean } = {}): TenantContext | undefined {
  const proto = req.header('x-forwarded-proto') ?? req.protocol;
  const result = resolveTenant(req.header('host'), proto, tenantOptions);
  if (result.ok) return result.context;
  if (opts.silent) return undefined;
  res.status(result.status).json({ error: result.error, error_description: result.detail });
  return undefined;
}

// ─── MCP Streamable HTTP transport ──────────────────────────────────────────
//
// Session state is pinned at init:
//   - ownerSub:    OAuth sub of the user who started the session
//   - tenantHost:  Orgo tenant the session targets
//   - client:      OrgoClient with the tenant's base URL
//
// Every subsequent request on the same sessionId must present a bearer for the
// same sub AND must arrive at the same tenant hostname. On match, we rotate
// the OrgoClient's stored credential to the request's current bearer (so an
// expired-and-refreshed token transparently replaces the old one).

function dropSession(id: string) {
  transports.delete(id);
  sessions.delete(id);
  metrics.activeSessions.set(sessions.size());
}

app.post('/mcp', requireBearerAndTenant, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    const tenantCfg = buildTenantConfig(req.orgoTenant!.tenantHost, req.orgoBearer!);
    const client = new OrgoClient(tenantCfg);
    const server = buildServer({ config: tenantCfg, client });
    const ownerSub = req.orgoIdentity!.sub;
    const tenantHost = req.orgoTenant!.tenantHost;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        sessions.set(id, {
          ownerSub,
          tenantHost,
          client,
          transport: transport!,
          createdAt: Date.now(),
        });
        metrics.activeSessions.set(sessions.size());
        log.info('session_initialized', { sessionId: id, sub: ownerSub, tenantHost });
      },
    });

    transport.onclose = () => {
      const id = transport!.sessionId;
      if (id) {
        dropSession(id);
        log.info('session_closed', { sessionId: id });
      }
    };

    await server.connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No session and no initialize request' },
      id: null,
    });
    return;
  } else {
    if (!enforceSessionIdentity(req, res, sessionId!)) return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireBearerAndTenant, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport || !sessionId) {
    res.status(404).json({ error: 'unknown_session' });
    return;
  }
  if (!enforceSessionIdentity(req, res, sessionId)) return;
  await transport.handleRequest(req, res);
});

app.delete('/mcp', requireBearerAndTenant, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport || !sessionId) {
    res.status(404).json({ error: 'unknown_session' });
    return;
  }
  if (!enforceSessionIdentity(req, res, sessionId)) return;
  await transport.handleRequest(req, res);
});

/**
 * Verify (a) the request's sub matches the session's owner, AND (b) the
 * request's resolved tenant matches the session's tenant. On match, rotate
 * the OrgoClient's stored credential to the request's current bearer.
 */
function enforceSessionIdentity(req: Request, res: Response, sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) {
    res.status(404).json({ error: 'unknown_session' });
    return false;
  }
  if (state.ownerSub !== req.orgoIdentity!.sub) {
    metrics.sessionOwnerMismatches.inc();
    log.warn('session_owner_mismatch', {
      sessionId,
      sessionOwner: state.ownerSub,
      requestSub: req.orgoIdentity!.sub,
      tenantHost: state.tenantHost,
    });
    res.status(403).json({
      error: 'session_owner_mismatch',
      error_description: 'This MCP session belongs to a different user.',
    });
    return false;
  }
  if (state.tenantHost !== req.orgoTenant!.tenantHost) {
    log.warn('session_tenant_mismatch', {
      sessionId,
      sessionTenant: state.tenantHost,
      requestTenant: req.orgoTenant!.tenantHost,
    });
    res.status(403).json({
      error: 'session_tenant_mismatch',
      error_description: 'This MCP session was created against a different tenant.',
    });
    return false;
  }
  state.client.setAuth({ kind: 'oauth', token: req.orgoBearer! });
  return true;
}

app.listen(PORT, HOST, () => {
  log.info('orgo_mcp_http_started', {
    port: PORT,
    host: HOST,
    orgoAuthBaseUrl: ORGO_AUTH_BASE_URL,
    singleTenantOverride: tenantOptions.singleTenantHost ?? null,
    allowedSuffixes: tenantOptions.allowedSuffixes,
    routingPattern: tenantOptions.hostPattern.source,
  });
});
