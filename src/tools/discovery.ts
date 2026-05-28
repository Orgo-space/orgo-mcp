/**
 * Discovery tools: how the model navigates 458 endpoints without bloat.
 *
 *   list_endpoints      → filter + paginate the endpoint index
 *   describe_endpoint   → full spec for one operation (params, body, responses, samples)
 *   list_resources      → list of tags (resource families) with descriptions
 *   describe_resource   → tag description + all endpoints for that tag
 *   search_schemas      → look up a model schema by name (e.g. "User", "Event")
 *   list_webhooks       → list webhook events
 *   describe_webhook    → payload schema + example for a single event
 *
 * The pattern: lazy descent. The model lists, narrows, then drills into a
 * single endpoint or schema only when ready to call.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenApiIndex, Operation } from '../lib/openapi.js';
import { jsonResult, textResult } from './shared.js';

export function registerDiscoveryTools(server: McpServer, index: OpenApiIndex) {
  server.registerTool(
    'list_endpoints',
    {
      title: 'List Orgo API endpoints',
      description:
        'Search the catalog of Orgo API endpoints. Filter by tag (e.g. "Event", "User"), HTTP method, and/or a free-text query. ' +
        'Returns up to `limit` matches with operationId, method, path, tag, and one-line summary. ' +
        'Use this first to discover the right endpoint, then call `describe_endpoint` for full details before calling `call_endpoint`.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text search across path, summary, operationId, tag, description.'),
        tag: z
          .string()
          .optional()
          .describe('Exact tag (resource family) to filter by. Use `list_resources` to see all tags.'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .optional()
          .describe('HTTP method to filter by.'),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ query, tag, method, limit }) => {
      const results = index.searchEndpoints({ query, tag, method, limit });
      return jsonResult({
        totalIndexed: index.endpoints.length,
        returned: results.length,
        results,
      });
    },
  );

  server.registerTool(
    'describe_endpoint',
    {
      title: 'Describe an Orgo API endpoint',
      description:
        'Return the full OpenAPI specification for one endpoint: parameters, request body schema, ' +
        'response schemas (all status codes), authentication, and any hand-curated code samples. ' +
        'Identify the endpoint by `operationId` (preferred) OR by `method` + `path`. ' +
        'Read this before calling `call_endpoint` so you know which parameters and body fields are required.',
      inputSchema: {
        operationId: z
          .string()
          .optional()
          .describe('OpenAPI operationId, e.g. "api_users_get_collection".'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        path: z
          .string()
          .optional()
          .describe('Path with placeholders, e.g. "/api/v1/users/{id}".'),
      },
    },
    async ({ operationId, method, path }) => {
      let lookup: { method: string; path: string; op: Operation } | undefined;
      if (operationId) {
        lookup = index.findById(operationId);
        if (!lookup) {
          return textResult(`No operation with operationId "${operationId}".`, true);
        }
      } else if (method && path) {
        const op = index.findOperation(method, path);
        if (!op) return textResult(`No operation ${method} ${path}.`, true);
        lookup = { method, path, op };
      } else {
        return textResult('Provide either `operationId` or both `method` and `path`.', true);
      }

      const { op } = lookup;
      return jsonResult({
        operationId: op.operationId,
        method: lookup.method,
        path: lookup.path,
        tag: op.tags?.[0],
        summary: op.summary,
        description: op.description,
        deprecated: Boolean(op.deprecated),
        security: op.security,
        parameters: op.parameters ?? [],
        requestBody: op.requestBody,
        responses: op.responses,
        codeSamples: op['x-codeSamples'] ?? [],
      });
    },
  );

  server.registerTool(
    'list_resources',
    {
      title: 'List Orgo resource families (tags)',
      description:
        'Return all 118 resource families (User, Event, Contact, Payment, etc.) with a multi-sentence ' +
        'description explaining what each entity is, its lifecycle (where applicable), and how it relates ' +
        'to other entities. Use this to orient yourself before drilling into endpoints.',
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        count: index.tags.length,
        tags: index.tags.map((t) => ({
          name: t.name,
          endpointCount: index.listByTag(t.name).length,
          description: t.description,
        })),
      });
    },
  );

  server.registerTool(
    'describe_resource',
    {
      title: 'Describe an Orgo resource family',
      description:
        'Return the description of one tag plus the full list of its endpoints (operationId, method, path, summary). ' +
        'Useful when you have a high-level goal ("manage members", "sell tickets") and want to see every operation available.',
      inputSchema: {
        tag: z.string().describe('Tag name, e.g. "User", "Event", "Contact". Case-insensitive.'),
      },
    },
    async ({ tag }) => {
      const t = index.findTag(tag);
      if (!t) return textResult(`No tag "${tag}". Call list_resources for the full list.`, true);
      return jsonResult({
        name: t.name,
        description: t.description,
        endpoints: index.listByTag(t.name),
      });
    },
  );

  server.registerTool(
    'describe_schema',
    {
      title: 'Describe a model schema',
      description:
        'Return the JSON Schema for a model from components.schemas. ' +
        'Example schema names: "User-user_read", "Event.jsonld-event_read", "Adhesion-adhesion_write". ' +
        'Use this when a request body or response references a schema you need to understand.',
      inputSchema: {
        name: z.string().describe('Schema name from components.schemas.'),
      },
    },
    async ({ name }) => {
      const schemas = (index.spec.components?.schemas ?? {}) as Record<string, unknown>;
      const exact = schemas[name];
      if (exact) return jsonResult({ name, schema: exact });

      const lower = name.toLowerCase();
      const matches = Object.keys(schemas)
        .filter((k) => k.toLowerCase().includes(lower))
        .slice(0, 25);
      if (matches.length === 0) {
        return textResult(`No schema matches "${name}".`, true);
      }
      return jsonResult({
        hint: `No exact match. Showing ${matches.length} schema names containing "${name}":`,
        matches,
      });
    },
  );

  server.registerTool(
    'list_webhooks',
    {
      title: 'List Orgo webhook events',
      description:
        'Return all webhook events Orgo can deliver (e.g. user.created, payment.completed, adhesion.submitted). ' +
        'Each entry includes summary and description. Use `describe_webhook` for the payload schema.',
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        count: index.webhookIndex.length,
        events: index.webhookIndex,
      });
    },
  );

  server.registerTool(
    'describe_webhook',
    {
      title: 'Describe a webhook event',
      description:
        'Return the full payload schema and an example for one webhook event. ' +
        'Use this before implementing a webhook handler.',
      inputSchema: {
        event: z.string().describe('Event name, e.g. "user.created".'),
      },
    },
    async ({ event }) => {
      const w = index.findWebhook(event);
      if (!w) return textResult(`Unknown webhook event "${event}". Call list_webhooks.`, true);
      return jsonResult({
        event,
        summary: w.summary,
        description: w.description,
        payload: w.op?.requestBody,
      });
    },
  );
}
