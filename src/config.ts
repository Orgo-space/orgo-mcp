/**
 * Environment configuration.
 *
 * Tenant resolution: Orgo determines tenant from the HTTP `Host` header. The MCP
 * server must therefore know which host to talk to. Calls to `app.orgo.space`
 * return 404 for tenant-scoped endpoints — only the OAuth/login flows accept it.
 *
 * See: https://orgo.space/docs/api-reference/concepts/tenancy
 */

export interface OrgoConfig {
  tenantHost: string;
  protocol: 'https' | 'http';
  baseUrl: string;
  timeoutMs: number;
  auth: AuthConfig;
}

export type AuthConfig =
  | { kind: 'api-token'; token: string }
  | { kind: 'jwt'; token: string }
  | { kind: 'oauth'; token: string }
  | { kind: 'contact-hash'; hash: string }
  | { kind: 'none' };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrgoConfig {
  const tenantHost = env.ORGO_TENANT_HOST?.trim();
  if (!tenantHost) {
    throw new Error(
      'ORGO_TENANT_HOST is required. Set it to your tenant host (e.g. acme.orgo.space). ' +
        'See https://orgo.space/docs/api-reference/concepts/tenancy.',
    );
  }
  if (tenantHost.includes('://')) {
    throw new Error(
      `ORGO_TENANT_HOST must be a bare host (no scheme). Got "${tenantHost}". ` +
        'Example: acme.orgo.space',
    );
  }

  const protocol = (env.ORGO_PROTOCOL?.trim() ?? 'https') as 'https' | 'http';
  if (protocol !== 'https' && protocol !== 'http') {
    throw new Error(`ORGO_PROTOCOL must be "https" or "http", got "${protocol}".`);
  }

  const timeoutMs = Number(env.ORGO_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`ORGO_TIMEOUT_MS must be a positive number, got "${env.ORGO_TIMEOUT_MS}".`);
  }

  return {
    tenantHost,
    protocol,
    baseUrl: `${protocol}://${tenantHost}`,
    timeoutMs,
    auth: pickAuth(env),
  };
}

function pickAuth(env: NodeJS.ProcessEnv): AuthConfig {
  // Precedence matches the docs' recommendation order for headless agents.
  if (env.ORGO_API_TOKEN?.trim()) return { kind: 'api-token', token: env.ORGO_API_TOKEN.trim() };
  if (env.ORGO_JWT?.trim()) return { kind: 'jwt', token: env.ORGO_JWT.trim() };
  if (env.ORGO_OAUTH_TOKEN?.trim()) return { kind: 'oauth', token: env.ORGO_OAUTH_TOKEN.trim() };
  if (env.ORGO_CONTACT_HASH?.trim()) return { kind: 'contact-hash', hash: env.ORGO_CONTACT_HASH.trim() };
  return { kind: 'none' };
}

export function describeAuth(auth: AuthConfig): string {
  switch (auth.kind) {
    case 'api-token':
      return 'Api-Token header';
    case 'jwt':
      return 'Authorization: Bearer (JWT)';
    case 'oauth':
      return 'Authorization: Bearer (OAuth)';
    case 'contact-hash':
      return 'X-Contact-Hash';
    case 'none':
      return 'unauthenticated (only public endpoints will work)';
  }
}
