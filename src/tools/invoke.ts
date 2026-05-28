/**
 * call_endpoint — the workhorse. Invokes any one of the 458 documented Orgo endpoints.
 *
 * Design notes:
 *   - The tool validates the (method, path) is known before firing. This catches
 *     hallucinated paths (e.g. /api/v1/membres) and points the model at the
 *     real catalog via list_endpoints.
 *   - Path templating: {id} placeholders are filled from `pathParams`.
 *   - Query params accept arrays — they're serialized as `?field[]=a&field[]=b`
 *     per API Platform / Hydra convention.
 *   - Errors are returned as tool results, not thrown, so the model can read
 *     the 422 violations and recover.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenApiIndex } from '../lib/openapi.js';
import type { OrgoClient } from '../lib/client.js';
import { jsonResult, textResult } from './shared.js';

export function registerInvokeTool(server: McpServer, index: OpenApiIndex, client: OrgoClient) {
  server.registerTool(
    'call_endpoint',
    {
      title: 'Call an Orgo API endpoint',
      description:
        'Invoke any of the 458 documented Orgo endpoints. Before calling, look up the endpoint with ' +
        '`describe_endpoint` so you know which parameters and body fields are required. ' +
        'Path placeholders like `{id}` are filled from `pathParams`. ' +
        'Query parameters support arrays (serialized as field[]=a&field[]=b for OR-filters) and ' +
        'date ranges via API Platform syntax (e.g. `startDate[after]=2026-01-01`). ' +
        'PATCH requests are sent with `application/merge-patch+json` by default. ' +
        'Non-2xx responses are returned as structured errors with the violation list (422) — recover, do not retry blindly.',
      inputSchema: {
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .describe('HTTP method.'),
        path: z
          .string()
          .describe(
            'Path with placeholders, e.g. "/api/v1/users/{id}". Must match a path in the catalog (use list_endpoints to discover).',
          ),
        pathParams: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe('Values for {placeholders} in the path. E.g. { id: 42 }.'),
        query: z
          .record(
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string(), z.number()])),
            ]),
          )
          .optional()
          .describe(
            'Query parameters. Arrays become field[]= entries. Use API Platform syntax for ranges (e.g. {"startDate[after]": "2026-01-01T00:00:00Z"}).',
          ),
        body: z
          .unknown()
          .optional()
          .describe('Request body (JSON-serializable). Required for most POST/PUT/PATCH endpoints.'),
        accept: z
          .string()
          .optional()
          .describe('Override response Accept header. Defaults to application/ld+json. Use "application/json" for plain JSON or "text/csv" for CSV exports.'),
        contentType: z
          .string()
          .optional()
          .describe('Override request Content-Type. Defaults: application/merge-patch+json for PATCH, application/ld+json otherwise.'),
      },
    },
    async ({ method, path, pathParams, query, body, accept, contentType }) => {
      const realized = realizePath(path, pathParams);
      if (realized.startsWith('__error:')) {
        return textResult(realized.slice('__error:'.length), true);
      }

      // Validate against the catalog so hallucinated paths fail loud.
      const known = index.findOperation(method, path);
      if (!known) {
        const candidates = index.searchEndpoints({ query: path, limit: 5 });
        return textResult(
          `Unknown endpoint ${method} ${path}. ` +
            `Use list_endpoints to discover the real endpoint. ` +
            `Closest matches:\n${candidates.map((c) => `  ${c.method} ${c.path} — ${c.summary}`).join('\n') || '  (none)'}`,
          true,
        );
      }

      const queryNormalized = normalizeQuery(query);
      const res = await client.call({
        method,
        path: realized,
        query: queryNormalized,
        body: body as unknown,
        accept,
        contentType,
      });

      const summary = {
        request: { method, path: realized, query: queryNormalized, hasBody: body !== undefined },
        response: {
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          headers: pickHeaders(res.headers),
          body: res.body,
        },
      };
      return jsonResult(summary);
    },
  );
}

function realizePath(path: string, params?: Record<string, string | number>): string {
  if (!path.includes('{')) return path;
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') {
      return `__error:Missing path parameter "${name}" for path ${path}.`;
    }
    return encodeURIComponent(String(v));
  });
}

function normalizeQuery(
  query?: Record<string, string | number | boolean | (string | number)[]>,
): Record<string, string | number | boolean | (string | number)[]> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number | boolean | (string | number)[]> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

// Drop hop-by-hop and noisy headers; keep the ones useful to the model.
function pickHeaders(all: Record<string, string>): Record<string, string> {
  const keep = [
    'content-type',
    'link',
    'x-total-count',
    'x-pagination-page',
    'x-pagination-total-pages',
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'location',
  ];
  const out: Record<string, string> = {};
  for (const k of keep) if (all[k]) out[k] = all[k];
  return out;
}
