import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTenant, loadTenantResolverOptions } from '../src/lib/tenant.js';

// Production runs single-tenant: every session talks to app.orgo.space, while
// Orgo hands each organisation https://{slug}.mcp.orgo.space/mcp.
const prod = loadTenantResolverOptions({
  ORGO_TENANT_HOST: 'app.orgo.space',
  ORGO_PUBLIC_BASE_URL: 'https://mcp.orgo.space',
  ORGO_ALLOWED_TENANT_SUFFIXES: '.orgo.space',
});

function ctx(host: string | undefined, opts = prod) {
  const r = resolveTenant(host, 'https', opts);
  assert.ok(r.ok, JSON.stringify(r));
  return r.context;
}

test('a tenant subdomain is its own protected resource (RFC 9728 origin match)', () => {
  // Claude Code rejects metadata whose `resource` differs from the URL it was
  // given, so eusoi.mcp.orgo.space must not advertise the apex.
  assert.deepEqual(ctx('eusoi.mcp.orgo.space'), {
    tenantHost: 'app.orgo.space',
    publicBaseUrl: 'https://eusoi.mcp.orgo.space',
  });
});

test('the apex keeps the configured public URL', () => {
  assert.equal(ctx('mcp.orgo.space').publicBaseUrl, 'https://mcp.orgo.space');
});

test('an unroutable or foreign Host falls back to the configured URL, never echoes', () => {
  assert.equal(ctx('evil.example.com').publicBaseUrl, 'https://mcp.orgo.space');
  assert.equal(ctx('x.mcp.evil.com').publicBaseUrl, 'https://mcp.orgo.space');
  assert.equal(ctx(undefined).publicBaseUrl, 'https://mcp.orgo.space');
});

test('the tenant stays pinned whatever the Host says', () => {
  assert.equal(ctx('other.mcp.orgo.space').tenantHost, 'app.orgo.space');
});

test('multi-tenant routing is unchanged', () => {
  const multi = loadTenantResolverOptions({ ORGO_ALLOWED_TENANT_SUFFIXES: '.orgo.space' });
  assert.deepEqual(ctx('acme.mcp.orgo.space', multi), {
    tenantHost: 'acme.orgo.space',
    publicBaseUrl: 'https://acme.mcp.orgo.space',
  });
});
