/**
 * Smoke test: spawn the stdio MCP server, send `initialize` + `tools/list` +
 * `resources/list` + `prompts/list` + a `tools/call` for list_endpoints, and
 * print a summary. Verifies the wiring end-to-end without touching the live API.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('node', ['dist/index.js'], {
  env: { ...process.env, ORGO_TENANT_HOST: 'example.orgo.space', ORGO_API_TOKEN: 'test-only' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = createInterface({ input: child.stdout });

let id = 0;
const pending = new Map();

function send(method, params) {
  const reqId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    const payload = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params });
    child.stdin.write(payload + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});

(async () => {
  // 1. Initialize
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-stdio', version: '0.0.0' },
  });
  console.log('initialize ->', init.result?.serverInfo, 'caps:', Object.keys(init.result?.capabilities ?? {}));
  notify('notifications/initialized', {});

  // 2. tools/list
  const tools = await send('tools/list', {});
  console.log('tools/list ->', tools.result?.tools?.length, 'tools:', tools.result?.tools?.map((t) => t.name));

  // 3. resources/list
  const resources = await send('resources/list', {});
  console.log('resources/list ->', resources.result?.resources?.length, 'resources');

  // 4. prompts/list
  const prompts = await send('prompts/list', {});
  console.log('prompts/list ->', prompts.result?.prompts?.length, 'prompts');

  // 5. tools/call list_endpoints {tag: 'Event'}
  const call = await send('tools/call', {
    name: 'list_endpoints',
    arguments: { tag: 'Event', limit: 3 },
  });
  const parsed = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
  console.log('list_endpoints{tag:Event,limit:3} -> total', parsed.totalIndexed, 'returned', parsed.returned);
  console.log('  first result:', parsed.results?.[0]?.method, parsed.results?.[0]?.path, '-', parsed.results?.[0]?.summary);

  // 6. tools/call describe_resource {tag: 'Adhesion'}
  const describe = await send('tools/call', {
    name: 'describe_resource',
    arguments: { tag: 'Adhesion' },
  });
  const dp = JSON.parse(describe.result?.content?.[0]?.text ?? '{}');
  console.log('describe_resource{tag:Adhesion} -> endpoints:', dp.endpoints?.length, 'desc.head:', dp.description?.slice(0, 80) + '...');

  child.kill('SIGTERM');
  process.exit(0);
})().catch((e) => {
  console.error('smoke failed:', e);
  child.kill('SIGTERM');
  process.exit(1);
});
