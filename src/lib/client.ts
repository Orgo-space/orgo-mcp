/**
 * Orgo HTTP client.
 *
 * Encapsulates:
 *   - Tenant-host targeting (https://{tenant}.orgo.space/api/v1/...)
 *   - The five auth methods documented in concepts/authentication.md
 *   - Hydra-aware decoding (default Accept: application/ld+json)
 *   - Single retry on 429 honoring `Retry-After` (per concepts/errors.md)
 *   - Structured error mapping (title/detail/status, validation violations)
 *
 * Deliberately *no* general retry loop on 5xx — the caller (Claude) can
 * decide. Keeping retries minimal makes tool calls feel synchronous.
 */

import type { AuthConfig, OrgoConfig } from '../config.js';

export interface CallEndpointOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | (string | number)[]>;
  body?: unknown;
  /** Override the default `Accept` header. Use `application/json` for plain JSON or `text/csv` for CSV exports. */
  accept?: string;
  /** Override the default `Content-Type` for the request body. Use `application/merge-patch+json` for PATCH. */
  contentType?: string;
  /** Extra headers to merge in. Auth header is always set by the client. */
  headers?: Record<string, string>;
}

export interface OrgoResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Parsed body if JSON, raw string otherwise (e.g. CSV exports, PDFs). */
  body: unknown;
  /** Whether the response was a non-2xx that we packaged as a structured error. */
  ok: boolean;
}

export interface OrgoApiError {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  violations?: { propertyPath: string; message: string; code?: string }[];
}

export class OrgoClient {
  private auth: AuthConfig;

  constructor(private readonly config: OrgoConfig) {
    this.auth = config.auth;
  }

  /**
   * Replace the auth credential used for outbound requests. Used by the HTTP
   * transport to bind each request's freshly-validated bearer to the session's
   * client, so an expiring or rotated token cannot outlive the user's actual
   * grant and so we never reuse a credential validated minutes earlier.
   */
  setAuth(auth: AuthConfig): void {
    this.auth = auth;
  }

  async call(opts: CallEndpointOptions): Promise<OrgoResponse> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts);
    const init: RequestInit = {
      method: opts.method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };

    if (opts.body !== undefined && opts.body !== null && !isGet(opts.method)) {
      if (opts.body instanceof FormData || typeof opts.body === 'string') {
        init.body = opts.body as RequestInit['body'];
      } else {
        init.body = JSON.stringify(opts.body);
      }
    }

    const first = await fetch(url, init);
    if (first.status === 429) {
      const retryAfter = parseRetryAfter(first.headers.get('retry-after'));
      if (retryAfter !== null && retryAfter <= 30) {
        await sleep(retryAfter * 1000);
        const second = await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
        return await packageResponse(second);
      }
    }
    return await packageResponse(first);
  }

  private buildUrl(path: string, query?: CallEndpointOptions['query']): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(normalized, this.config.baseUrl);
    if (query) {
      for (const [key, raw] of Object.entries(query)) {
        if (raw === undefined || raw === null) continue;
        if (Array.isArray(raw)) {
          for (const v of raw) url.searchParams.append(`${key}[]`, String(v));
        } else {
          url.searchParams.append(key, String(raw));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(opts: CallEndpointOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: opts.accept ?? 'application/ld+json',
      ...applyAuth(this.auth),
      ...(opts.headers ?? {}),
    };

    const hasBody = opts.body !== undefined && opts.body !== null && !isGet(opts.method);
    if (hasBody && !(opts.body instanceof FormData)) {
      // API Platform expects merge-patch for PATCH and JSON-LD for everything else.
      const defaultCt =
        opts.method.toUpperCase() === 'PATCH' ? 'application/merge-patch+json' : 'application/ld+json';
      headers['Content-Type'] = opts.contentType ?? defaultCt;
    }

    return headers;
  }
}

function applyAuth(auth: AuthConfig): Record<string, string> {
  switch (auth.kind) {
    case 'api-token':
      return { 'Api-Token': auth.token };
    case 'jwt':
      return { Authorization: `Bearer ${auth.token}` };
    case 'oauth':
      return { Authorization: `Bearer ${auth.token}` };
    case 'contact-hash':
      return { 'X-Contact-Hash': auth.hash };
    case 'none':
      return {};
  }
}

async function packageResponse(res: Response): Promise<OrgoResponse> {
  const headers = Object.fromEntries(res.headers.entries());
  const ct = res.headers.get('content-type') ?? '';
  let body: unknown;

  if (res.status === 204 || res.status === 205) {
    body = null;
  } else if (ct.includes('json')) {
    const text = await res.text();
    body = text ? safeJsonParse(text) : null;
  } else if (ct.startsWith('text/')) {
    body = await res.text();
  } else {
    // Binary (PDFs, images). Surface a marker instead of returning bytes through MCP.
    const buf = await res.arrayBuffer();
    body = { __orgoBinary: true, contentType: ct, byteLength: buf.byteLength };
  }

  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body,
    ok: res.ok,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isGet(method: string): boolean {
  return method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD';
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
