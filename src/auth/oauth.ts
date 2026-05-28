/**
 * OAuth glue for the hosted MCP server.
 *
 * Orgo's OAuth server (at https://app.orgo.space/oauth/*) does NOT publish:
 *   - RFC 8414 Authorization Server Metadata
 *   - RFC 9728 Protected Resource Metadata
 *   - RFC 7591 Dynamic Client Registration
 *
 * The MCP spec (2025-06-18) expects those documents so clients like Claude.ai
 * can auto-configure. We therefore expose them ourselves: the MCP server
 * advertises Orgo's authorization+token endpoints in a synthetic RFC 8414
 * document, hosted at /.well-known/oauth-authorization-server on the MCP host.
 *
 * Token validation:
 *   - Bearer tokens are validated by calling GET {orgoBase}/oauth/userinfo.
 *     If userinfo returns 200, the token is live; if 401, it's invalid.
 *   - Results are cached in-memory by token hash with a short TTL so we don't
 *     hit userinfo on every JSON-RPC call.
 *   - The validated identity is attached to the request and used to derive
 *     the per-session OrgoClient (which sends the same bearer to all API calls).
 */

import { createHash } from 'node:crypto';

export interface OAuthOptions {
  /** Public base URL of *this* MCP server (e.g. https://mcp.orgo.space). Used in metadata documents. */
  publicBaseUrl: string;
  /** Base URL of the Orgo OAuth server (typically https://app.orgo.space). */
  orgoAuthBaseUrl: string;
  /** Scopes the MCP server advertises as required. */
  scopes: string[];
  /** Token cache TTL in seconds (default 60). */
  cacheTtlSeconds?: number;
}

export interface TokenIdentity {
  sub: string;
  name?: string;
  email?: string;
  roles?: string[];
  groups?: string[];
  scope?: string;
  expiresAt: number;
}

export class OAuthValidator {
  private readonly cache = new Map<string, TokenIdentity>();
  private readonly ttl: number;

  constructor(private readonly opts: OAuthOptions) {
    this.ttl = (opts.cacheTtlSeconds ?? 60) * 1000;
  }

  /**
   * Returns the document served at /.well-known/oauth-protected-resource.
   * Tells clients which authorization server protects this resource.
   * See: https://datatracker.ietf.org/doc/html/rfc9728
   */
  protectedResourceMetadata() {
    return {
      resource: this.opts.publicBaseUrl,
      authorization_servers: [this.opts.publicBaseUrl], // we proxy Orgo's AS metadata
      scopes_supported: this.opts.scopes,
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://orgo.space/docs/api-reference',
    };
  }

  /**
   * Returns the document served at /.well-known/oauth-authorization-server.
   * Synthesized to point at Orgo's actual OAuth endpoints because Orgo does
   * not publish this document itself. See: RFC 8414.
   */
  authorizationServerMetadata() {
    return {
      issuer: this.opts.publicBaseUrl,
      authorization_endpoint: `${this.opts.orgoAuthBaseUrl}/oauth/authorize`,
      token_endpoint: `${this.opts.orgoAuthBaseUrl}/oauth/token`,
      userinfo_endpoint: `${this.opts.orgoAuthBaseUrl}/oauth/userinfo`,
      scopes_supported: this.opts.scopes,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      // No registration_endpoint: Orgo does not support DCR. Clients must use a
      // pre-registered client_id, configured manually in the connector.
    };
  }

  async validate(bearer: string): Promise<TokenIdentity | null> {
    const key = hashToken(bearer);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached;

    let res: Response;
    try {
      res = await fetch(`${this.opts.orgoAuthBaseUrl}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.cache.delete(key);
      return null;
    }
    if (!res.ok) {
      this.cache.delete(key);
      return null;
    }

    // Orgo's webserver returns the SPA HTML on unknown paths or for tokens that
    // don't reach userinfo (e.g. misconfigured auth base URL). Treat anything
    // non-JSON as an invalid token — never throw to the caller.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('json')) {
      this.cache.delete(key);
      return null;
    }
    let userinfo: Record<string, unknown>;
    try {
      userinfo = (await res.json()) as Record<string, unknown>;
    } catch {
      this.cache.delete(key);
      return null;
    }
    if (!userinfo.sub || typeof userinfo.sub !== 'string') {
      this.cache.delete(key);
      return null;
    }

    const identity: TokenIdentity = {
      sub: userinfo.sub,
      name: optString(userinfo.name),
      email: optString(userinfo.email),
      roles: optStringArray(userinfo.roles),
      groups: optStringArray(userinfo.groups),
      scope: optString(userinfo.scope),
      expiresAt: now + this.ttl,
    };
    this.cache.set(key, identity);
    return identity;
  }
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function optStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}
