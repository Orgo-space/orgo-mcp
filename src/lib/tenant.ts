/**
 * Tenant resolution + SSRF guard.
 *
 * Orgo's API resolves tenant from the `Host` header. The MCP server's HTTP
 * front-end mirrors that model: the URL `mcp.acme.orgo.space` maps to the
 * Orgo tenant `acme.orgo.space`. The function below performs that mapping
 * AND validates the result against a suffix allowlist before we trust it as
 * a hostname to make outbound calls to (otherwise an attacker who controls
 * DNS could pivot us into `169.254.169.254` / `internal-admin.local` / etc.).
 *
 * Two modes:
 *   - Single-tenant override: `ORGO_TENANT_HOST` is set. Every request maps
 *     to that tenant regardless of incoming Host. Useful for dedicated
 *     deployments on non-standard hostnames.
 *   - Multi-tenant (default): tenant is derived per-request via a regex
 *     against the incoming Host. Default pattern strips a leading `mcp.`.
 *
 * Env vars:
 *   ORGO_TENANT_HOST                — single-tenant override
 *   ORGO_TENANT_FROM_HOST_PATTERN   — regex with one capture group (default ^mcp\.(.+)$)
 *   ORGO_ALLOWED_TENANT_SUFFIXES    — comma-separated suffix allowlist (default .orgo.space)
 *   ORGO_PUBLIC_BASE_URL            — single-tenant override for the OAuth metadata `resource`/`issuer`
 */

export interface TenantContext {
  /** Orgo tenant host the API calls go to, e.g. `acme.orgo.space`. */
  tenantHost: string;
  /** Public URL of THIS MCP server, e.g. `https://mcp.acme.orgo.space`. Used in OAuth metadata. */
  publicBaseUrl: string;
}

export interface TenantResolverOptions {
  singleTenantHost?: string;
  singleTenantPublicBaseUrl?: string;
  hostPattern: RegExp;
  allowedSuffixes: string[];
}

export function loadTenantResolverOptions(env: NodeJS.ProcessEnv = process.env): TenantResolverOptions {
  const pattern = env.ORGO_TENANT_FROM_HOST_PATTERN?.trim() || '^mcp\\.(.+)$';
  let hostPattern: RegExp;
  try {
    hostPattern = new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`ORGO_TENANT_FROM_HOST_PATTERN is not a valid regex: ${(e as Error).message}`);
  }
  if (hostPattern.source.indexOf('(') === -1) {
    throw new Error(
      'ORGO_TENANT_FROM_HOST_PATTERN must contain a capture group for the tenant host (default: ^mcp\\.(.+)$)',
    );
  }

  const suffixes = (env.ORGO_ALLOWED_TENANT_SUFFIXES?.trim() || '.orgo.space')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (suffixes.length === 0) {
    throw new Error('ORGO_ALLOWED_TENANT_SUFFIXES must contain at least one suffix.');
  }

  return {
    singleTenantHost: env.ORGO_TENANT_HOST?.trim() || undefined,
    singleTenantPublicBaseUrl: env.ORGO_PUBLIC_BASE_URL?.trim() || undefined,
    hostPattern,
    allowedSuffixes: suffixes,
  };
}

export interface TenantResolveResult {
  ok: true;
  context: TenantContext;
}

export interface TenantResolveError {
  ok: false;
  status: number;
  error: string;
  detail: string;
}

/**
 * Resolve the tenant for a request.
 *
 * @param hostHeader        the request's `Host` header (may include `:port`)
 * @param forwardedProto    `x-forwarded-proto` from the load balancer, if present
 * @param options           output of loadTenantResolverOptions()
 */
export function resolveTenant(
  hostHeader: string | undefined,
  forwardedProto: string | undefined,
  options: TenantResolverOptions,
): TenantResolveResult | TenantResolveError {
  // Single-tenant override: ignore Host entirely. Useful when the MCP server's
  // own hostname doesn't follow the `mcp.{tenant}` convention.
  if (options.singleTenantHost) {
    return {
      ok: true,
      context: {
        tenantHost: options.singleTenantHost,
        publicBaseUrl:
          options.singleTenantPublicBaseUrl ??
          buildPublicBaseUrl(hostHeader, forwardedProto) ??
          `https://${options.singleTenantHost}`,
      },
    };
  }

  if (!hostHeader) {
    return { ok: false, status: 400, error: 'missing_host', detail: 'Request has no Host header.' };
  }

  // Normalize: lowercase + strip :port. Reject anything with control chars
  // (defense against header smuggling, though Node's HTTP parser usually
  // catches this before us).
  const rawHost = hostHeader.split(',')[0].trim();
  if (/[\r\n\t\x00]/.test(rawHost)) {
    return { ok: false, status: 400, error: 'invalid_host', detail: 'Host header contains control characters.' };
  }
  const host = rawHost.split(':')[0].toLowerCase();
  if (!host) {
    return { ok: false, status: 400, error: 'invalid_host', detail: 'Host header is empty.' };
  }

  const match = options.hostPattern.exec(host);
  if (!match || !match[1]) {
    return {
      ok: false,
      status: 400,
      error: 'unrouteable_host',
      detail: `Host "${host}" did not match the tenant routing pattern ${options.hostPattern}.`,
    };
  }
  const tenantHost = match[1].toLowerCase();

  if (!options.allowedSuffixes.some((suffix) => tenantHost === suffix.replace(/^\./, '') || tenantHost.endsWith(suffix))) {
    return {
      ok: false,
      status: 400,
      error: 'forbidden_tenant',
      detail: `Tenant "${tenantHost}" is not in the allowed-suffix list (${options.allowedSuffixes.join(', ')}). This is an SSRF guard.`,
    };
  }

  const proto = (forwardedProto?.split(',')[0]?.trim() || 'https').toLowerCase();
  const safeProto = proto === 'http' ? 'http' : 'https';
  return {
    ok: true,
    context: {
      tenantHost,
      publicBaseUrl: `${safeProto}://${host}`,
    },
  };
}

function buildPublicBaseUrl(hostHeader: string | undefined, forwardedProto: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const host = hostHeader.split(',')[0].trim();
  const proto = (forwardedProto?.split(',')[0]?.trim() || 'https').toLowerCase();
  const safeProto = proto === 'http' ? 'http' : 'https';
  return `${safeProto}://${host}`;
}
