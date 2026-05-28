#!/usr/bin/env node
/**
 * Hosted MCP server with Streamable HTTP transport + OAuth (delegated to Orgo).
 *
 * Designed to be deployed at a single hostname (e.g. https://mcp.orgo.space)
 * and consumed by remote MCP clients: Claude.ai integrations, Gemini agent
 * connectors, OpenAI Responses API tool-use, custom agents, etc.
 *
 * Endpoints exposed:
 *   GET  /                                           — landing JSON ({name, version, mcp})
 *   GET  /.well-known/oauth-protected-resource       — RFC 9728 (points at our AS metadata)
 *   GET  /.well-known/oauth-authorization-server     — RFC 8414 (synthesized for Orgo)
 *   POST /mcp                                        — JSON-RPC over Streamable HTTP
 *   GET  /mcp                                        — SSE event stream (resumability)
 *   DEL  /mcp                                        — terminate session
 *
 * Auth: every /mcp request MUST carry an `Authorization: Bearer <orgo-oauth-token>`.
 * The same token is forwarded to Orgo's REST API as the user's identity.
 *
 * Tenant resolution: a single deployment serves ONE tenant by default,
 * configured via ORGO_TENANT_HOST. For multi-tenant hosting, run one instance
 * per tenant (matches Orgo's own per-tenant subdomain model) OR set
 * ORGO_TENANT_FROM_HOST_PATTERN to derive tenant from the connecting hostname.
 *
 * Env vars:
 *   ORGO_TENANT_HOST           (required if not derived) — e.g. acme.orgo.space
 *   ORGO_PUBLIC_BASE_URL       (required) — public URL of THIS mcp server, e.g. https://mcp.orgo.space
 *   ORGO_AUTH_BASE_URL         (default https://app.orgo.space) — Orgo OAuth server base
 *   ORGO_OAUTH_SCOPES          (default "profile email groups roles") — required scopes
 *   PORT                       (default 3333)
 *   HOST                       (default 0.0.0.0)
 */

import { randomUUID, createHash } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { OrgoClient } from './lib/client.js';
import { OAuthValidator, type TokenIdentity } from './auth/oauth.js';

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    orgoIdentity?: TokenIdentity;
    orgoBearer?: string;
  }
}

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_BASE_URL = process.env.ORGO_PUBLIC_BASE_URL?.replace(/\/$/, '');
const ORGO_AUTH_BASE_URL = (process.env.ORGO_AUTH_BASE_URL ?? 'https://app.orgo.space').replace(/\/$/, '');
const SCOPES = (process.env.ORGO_OAUTH_SCOPES ?? 'profile email groups roles').trim().split(/\s+/);

if (!PUBLIC_BASE_URL) {
  console.error('ORGO_PUBLIC_BASE_URL is required (e.g. https://mcp.orgo.space).');
  process.exit(1);
}

const baseConfig = loadConfig(); // requires ORGO_TENANT_HOST
const oauth = new OAuthValidator({
  publicBaseUrl: PUBLIC_BASE_URL,
  orgoAuthBaseUrl: ORGO_AUTH_BASE_URL,
  scopes: SCOPES,
});

const app = express();
app.use(express.json({ limit: '4mb' }));

// CORS — Claude.ai and other browser-based clients need this
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

// ─── Public landing / health ────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'orgo-mcp',
    version: '0.1.0',
    description: 'Hosted Model Context Protocol server for the Orgo API.',
    tenant: baseConfig.tenantHost,
    mcp: { transport: 'streamable-http', endpoint: '/mcp' },
    docs: 'https://orgo.space/docs/api-reference',
  });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// ─── OAuth metadata (RFC 8414 + RFC 9728) ───────────────────────────────────
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json(oauth.protectedResourceMetadata());
});

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json(oauth.authorizationServerMetadata());
});

// ─── Bearer auth middleware ─────────────────────────────────────────────────
async function requireBearer(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    unauthorized(res, 'missing_token');
    return;
  }
  const bearer = match[1].trim();
  const identity = await oauth.validate(bearer);
  if (!identity) {
    unauthorized(res, 'invalid_token');
    return;
  }
  req.orgoBearer = bearer;
  req.orgoIdentity = identity;
  next();
}

function unauthorized(res: Response, error: 'missing_token' | 'invalid_token') {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="orgo-mcp", error="${error}", resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({
    error,
    error_description:
      error === 'missing_token'
        ? 'Authorization: Bearer <orgo-oauth-token> required.'
        : 'The presented bearer token did not validate against Orgo userinfo.',
  });
}

// ─── MCP Streamable HTTP transport with per-session state ───────────────────
//
// Two pieces of session state are kept in lockstep:
//   - transports[sessionId]    → the SDK transport instance
//   - sessions[sessionId]      → { ownerSub, client }
//
// Identity binding: the OAuth `sub` of the user that initialized a session is
// pinned at that moment. Every subsequent request on the same sessionId must
// present a bearer for the SAME sub. This prevents session-ID hijack: even if
// user B somehow learns user A's sessionId and has their own valid Orgo bearer,
// B's `sub` will not match A's and the request is rejected with 403.
//
// Bearer rotation: the validated bearer from the CURRENT request replaces the
// OrgoClient's stored credential on every call. So if user A refreshes their
// token mid-session, outbound calls switch to the new credential immediately;
// if their token is revoked, the next call fails as it should.

interface SessionState {
  ownerSub: string;
  client: OrgoClient;
}

const transports = new Map<string, StreamableHTTPServerTransport>();
const sessions = new Map<string, SessionState>();

function dropSession(id: string) {
  transports.delete(id);
  sessions.delete(id);
}

app.post('/mcp', requireBearer, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    const sessionConfig = {
      ...baseConfig,
      auth: { kind: 'oauth' as const, token: req.orgoBearer! },
    };
    const client = new OrgoClient(sessionConfig);
    const server = buildServer({ config: sessionConfig, client });
    const ownerSub = req.orgoIdentity!.sub;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        sessions.set(id, { ownerSub, client });
      },
    });

    transport.onclose = () => {
      const id = transport!.sessionId;
      if (id) dropSession(id);
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
    // Reuse path — enforce identity binding and rotate the bearer.
    if (!enforceSessionIdentity(req, res, sessionId!)) return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — server-to-client SSE stream
app.get('/mcp', requireBearer, async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport || !sessionId) {
    res.status(404).json({ error: 'unknown_session' });
    return;
  }
  if (!enforceSessionIdentity(req, res, sessionId)) return;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — terminate session
app.delete('/mcp', requireBearer, async (req, res) => {
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
 * Verify the request's authenticated `sub` matches the session's owner and,
 * if so, rotate the session's outbound bearer to the request's bearer.
 * Returns false (and writes a response) on mismatch.
 */
function enforceSessionIdentity(req: Request, res: Response, sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) {
    res.status(404).json({ error: 'unknown_session' });
    return false;
  }
  if (state.ownerSub !== req.orgoIdentity!.sub) {
    res.status(403).json({
      error: 'session_owner_mismatch',
      error_description: 'This MCP session belongs to a different user.',
    });
    return false;
  }
  state.client.setAuth({ kind: 'oauth', token: req.orgoBearer! });
  return true;
}

app.listen(PORT, HOST, () => {
  // Logs go to stderr so stdout stays clean for any process supervisor that
  // captures it as protocol output (consistent with the stdio entry).
  console.error(`[orgo-mcp-http] listening on http://${HOST}:${PORT}`);
  console.error(`[orgo-mcp-http] public base URL: ${PUBLIC_BASE_URL}`);
  console.error(`[orgo-mcp-http] tenant: ${baseConfig.tenantHost}`);
  console.error(`[orgo-mcp-http] orgo OAuth server: ${ORGO_AUTH_BASE_URL}`);
  console.error(
    `[orgo-mcp-http] metadata: ${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource | /.well-known/oauth-authorization-server`,
  );
});

// Token-hashing helper exported for completeness (not used here but useful in tests)
export const debug = { tokenHash: (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16) };
