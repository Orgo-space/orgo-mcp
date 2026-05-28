#!/usr/bin/env node
/**
 * Automated smoke test for the hosted HTTP MCP server.
 *
 * What this exercises (no real Orgo backend, no real OAuth token):
 *   1. Bearer extraction from Authorization header → /oauth/userinfo validation
 *   2. Session creation pinned to (sub, tenant)
 *   3. tools/list returns 13 tools
 *   4. tools/call whoami → downstream API call carries the EXACT same bearer
 *   5. Reuse on same session = OK
 *   6. Hijack: same session id, different bearer (different sub) → 403
 *   7. Missing bearer → 401 with WWW-Authenticate header
 *
 * Strategy:
 *   - One mock HTTP server impersonates BOTH Orgo's /oauth/userinfo AND the
 *     Orgo REST API. It records every Authorization header it receives so we
 *     can assert the bearer flowed through unchanged.
 *   - The MCP HTTP server boots in single-tenant override mode pointing at
 *     the mock (ORGO_TENANT_HOST=localhost:PORT, ORGO_DOWNSTREAM_PROTOCOL=http).
 *   - We drive JSON-RPC over fetch against the MCP, verify responses, then
 *     cross-check what the mock saw.
 *
 * Run:  node scripts/smoke-http.mjs
 * Exit: 0 on full pass, 1 on any failure (suitable for CI).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const MOCK_PORT = 4001;
const MCP_PORT = 3344;
const TENANT_HOST = `localhost:${MOCK_PORT}`;

const assertions = [];
function assert(name, cond, detail = '') {
  assertions.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
}

// ─── 1. Mock Orgo (userinfo + API) ──────────────────────────────────────────
const mockLog = [];
const userinfoForToken = {
  'real-user-token': { sub: 'user_42', email: 'alice@example.com', roles: ['HR_LOCAL'] },
  'attacker-token': { sub: 'user_evil', email: 'mallory@example.com', roles: ['MEMBER'] },
};

const mock = createServer((req, res) => {
  const auth = req.headers.authorization ?? null;
  mockLog.push({ method: req.method, url: req.url, authorization: auth });
  res.setHeader('content-type', 'application/json');

  if (req.url === '/oauth/userinfo') {
    const bearer = auth?.replace(/^Bearer\s+/i, '');
    const userinfo = userinfoForToken[bearer];
    if (!userinfo) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    res.end(JSON.stringify(userinfo));
    return;
  }

  if (req.url === '/api/v1/me') {
    // The MCP forwarded the bearer; pretend the Orgo API accepts it
    res.end(JSON.stringify({ '@id': '/api/v1/users/42', id: 42, email: 'alice@example.com' }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'mock_not_found', url: req.url }));
});

await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
console.log(`[smoke] mock Orgo at http://127.0.0.1:${MOCK_PORT}`);

// ─── 2. Spawn the MCP HTTP server pointing at the mock ──────────────────────
const mcp = spawn('node', ['dist/http.js'], {
  env: {
    ...process.env,
    PORT: String(MCP_PORT),
    HOST: '127.0.0.1',
    ORGO_TENANT_HOST: TENANT_HOST, // single-tenant override
    ORGO_AUTH_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ORGO_DOWNSTREAM_PROTOCOL: 'http',
    ORGO_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
mcp.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d));

// Wait for /healthz to respond
for (let i = 0; i < 30; i++) {
  await sleep(100);
  try {
    const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`);
    if (r.ok) break;
  } catch { /* not up yet */ }
}
console.log(`[smoke] MCP up at http://127.0.0.1:${MCP_PORT}`);

let exitCode = 0;
try {
  await runChecks();
} catch (e) {
  console.error('[smoke] unexpected error:', e);
  exitCode = 1;
}

mcp.kill('SIGTERM');
mock.close();
await sleep(100);

const passed = assertions.filter((a) => a.ok).length;
const failed = assertions.filter((a) => !a.ok).length;
console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) exitCode = 1;
process.exit(exitCode);

// ─── 3. The actual test cases ───────────────────────────────────────────────
async function runChecks() {
  const REAL_TOKEN = 'real-user-token';
  const ATTACKER_TOKEN = 'attacker-token';
  const mcpUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;

  console.log('\nCheck 1: missing bearer → 401 with WWW-Authenticate');
  const r1 = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(initBody()),
  });
  assert('1a. 401 status', r1.status === 401, `got ${r1.status}`);
  assert(
    '1b. WWW-Authenticate header points at resource_metadata',
    (r1.headers.get('www-authenticate') ?? '').includes('resource_metadata='),
  );

  console.log('\nCheck 2: valid bearer → init creates session');
  const mockBefore = mockLog.length;
  const r2 = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      authorization: `Bearer ${REAL_TOKEN}`,
    },
    body: JSON.stringify(initBody()),
  });
  const sessionId = r2.headers.get('mcp-session-id');
  assert('2a. 200 status', r2.status === 200, `got ${r2.status}`);
  assert('2b. mcp-session-id header present', !!sessionId);
  const userinfoCall = mockLog.slice(mockBefore).find((l) => l.url === '/oauth/userinfo');
  assert('2c. mock /oauth/userinfo was called', !!userinfoCall);
  assert(
    '2d. userinfo received the EXACT inbound bearer (unchanged)',
    userinfoCall?.authorization === `Bearer ${REAL_TOKEN}`,
    `saw ${userinfoCall?.authorization}`,
  );

  console.log('\nCheck 3: tools/list returns 13 tools');
  const r3 = await fetchMcp(sessionId, REAL_TOKEN, { id: 2, method: 'tools/list' });
  assert('3a. 13 tools advertised', r3.result?.tools?.length === 13, `got ${r3.result?.tools?.length}`);
  const names = (r3.result?.tools ?? []).map((t) => t.name);
  assert('3b. includes whoami', names.includes('whoami'));
  assert('3c. includes call_endpoint', names.includes('call_endpoint'));

  console.log('\nCheck 4: tools/call whoami — bearer flows through to API call');
  const apiBefore = mockLog.filter((l) => l.url === '/api/v1/me').length;
  const r4 = await fetchMcp(sessionId, REAL_TOKEN, {
    id: 3,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  });
  assert('4a. tool returned no JSON-RPC error', !r4.error, JSON.stringify(r4.error));
  const apiCall = mockLog.filter((l) => l.url === '/api/v1/me')[apiBefore];
  assert('4b. mock API received the call', !!apiCall);
  assert(
    '4c. API received the EXACT bearer Claude.ai sent (this is the answer to "does it flow through")',
    apiCall?.authorization === `Bearer ${REAL_TOKEN}`,
    `saw ${apiCall?.authorization}`,
  );
  const toolBody = r4.result?.content?.[0]?.text ? JSON.parse(r4.result.content[0].text) : null;
  assert('4d. tool result body has the API response', toolBody?.body?.id === 42);

  console.log('\nCheck 5: hijack — same session, attacker bearer → 403 owner_mismatch');
  const r5 = await fetchMcpRaw(sessionId, ATTACKER_TOKEN, { id: 4, method: 'tools/list' });
  assert('5a. 403 status', r5.status === 403, `got ${r5.status}`);
  const body5 = await r5.json().catch(() => ({}));
  assert('5b. error is session_owner_mismatch', body5.error === 'session_owner_mismatch', JSON.stringify(body5));

  console.log('\nCheck 6: reuse on same session with original bearer still works');
  const r6 = await fetchMcp(sessionId, REAL_TOKEN, { id: 5, method: 'tools/list' });
  assert('6a. still returns tools', r6.result?.tools?.length === 13);
}

// ─── 4. JSON-RPC helpers ────────────────────────────────────────────────────
function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-http', version: '0' },
    },
  };
}

async function fetchMcpRaw(sessionId, bearer, payload) {
  return await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
  });
}

async function fetchMcp(sessionId, bearer, payload) {
  const res = await fetchMcpRaw(sessionId, bearer, payload);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // Streamable HTTP responses can come back as SSE; the first `data:` line
    // is the JSON-RPC response.
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(dataLine.replace(/^data:\s*/, ''));
  }
  return res.json();
}
