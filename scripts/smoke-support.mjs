#!/usr/bin/env node
/**
 * End-to-end smoke test for the support MCP over real HTTP.
 *
 * Starts dist/support.js against a throwaway fact index, then checks the things
 * that only a running process can prove:
 *
 *   - a request without the bearer is rejected
 *   - a relevant question returns the fact
 *   - an irrelevant question returns nothing, with the hand-off note
 *   - the response carries no citation and no internal identifiers
 *
 * Usage:  node scripts/smoke-support.mjs      (expects "npm run build" first)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 8899;
const BEARER = 'smoke-bearer-token-value';
const BASE = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'support-smoke-'));
const factsPath = join(dir, 'facts.serve.json');
writeFileSync(
  factsPath,
  JSON.stringify([
    {
      id: 'fee-parent-lc-scope',
      area: 'fees',
      asks: 'who can set fees for a local centre',
      answer: 'A parent local centre admin can set fees for the centres beneath them.',
    },
  ]),
);

const server = spawn(process.execPath, ['dist/support.js'], {
  env: { ...process.env, PORT: String(PORT), FACTS_PATH: factsPath, SUPPORT_BEARER: BEARER, SOURCE_SHA: 'smoke' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${BEARER}`,
};

/** The transport may answer as JSON or as a single SSE frame; accept both. */
async function readBody(res) {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

async function main() {
  const health = await waitForServer();
  check('healthz reports the loaded index', health.facts === 1, JSON.stringify(health));

  const noAuth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('rejects a request with no bearer', noAuth.status === 401, `status ${noAuth.status}`);

  const init = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id');
  check('initialize returns a session', Boolean(sessionId), `status ${init.status}`);

  const withSession = { ...MCP_HEADERS, 'mcp-session-id': sessionId };

  const stale = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  });
  check('unknown session gets 404, so Fin re-initializes after a restart', stale.status === 404, `status ${stale.status}`);

  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: withSession,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const list = await readBody(
    await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: withSession,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }),
  );
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check('exposes exactly one tool', names.length === 1 && names[0] === 'search_behavior_facts', names.join(', '));

  const call = async (query) =>
    readBody(
      await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: withSession,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_behavior_facts', arguments: { query } },
        }),
      }),
    );

  const hit = await call('who can set fees for a local centre');
  const hitText = hit.result?.content?.[0]?.text ?? '';
  check('relevant question returns the fact', hitText.includes('parent local centre admin'));
  check('response carries no citation', !/citation|Controller|\.php/i.test(hitText));

  const miss = await call('why did our Stripe payout not arrive this month');
  const missText = miss.result?.content?.[0]?.text ?? '';
  check('irrelevant question returns nothing', JSON.parse(missText).results.length === 0);
  check('irrelevant question tells Fin to hand off', /hand off/i.test(missText));
}

main()
  .catch((err) => {
    console.error(err);
    failures.push('unhandled error');
  })
  .finally(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
    console.log(failures.length === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures.length} failed`);
    process.exit(failures.length === 0 ? 0 : 1);
  });
