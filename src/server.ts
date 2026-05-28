/**
 * Server factory. Builds and configures an McpServer instance with all tools,
 * resources, and prompts. Transport-agnostic — the same factory is used by:
 *   - src/index.ts (stdio transport, for Claude Desktop and CLI clients)
 *   - src/http.ts  (Streamable HTTP transport, for remote clients like Claude.ai)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OpenApiIndex } from './lib/openapi.js';
import { OrgoClient } from './lib/client.js';
import type { OrgoConfig } from './config.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerInvokeTool } from './tools/invoke.js';
import { registerAuthTools } from './tools/auth.js';
import { registerDocResources } from './resources/docs.js';
import { registerPrompts } from './prompts/index.js';

export interface BuildOptions {
  config: OrgoConfig;
  /** Optional client override (e.g. a per-session client in HTTP mode). */
  client?: OrgoClient;
}

export function buildServer({ config, client }: BuildOptions): McpServer {
  const index = new OpenApiIndex();
  const httpClient = client ?? new OrgoClient(config);

  const server = new McpServer(
    {
      name: 'orgo-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      instructions:
        `You have access to the Orgo API — a member-management platform covering people, events, payments, ` +
        `contracts, communications, governance, and learning across 458 endpoints and 118 resource families.\n\n` +
        `Workflow:\n` +
        `  1. If unsure where to start, read orgo://docs/overview or orgo://docs/tags.\n` +
        `  2. Use list_endpoints / list_resources to discover the right operation.\n` +
        `  3. Use describe_endpoint to learn parameters and request/response shape.\n` +
        `  4. Use call_endpoint to execute. PATCH bodies are merge-patch by default.\n\n` +
        `Tenant context: ${config.tenantHost}. All calls hit this host.`,
    },
  );

  registerDiscoveryTools(server, index);
  registerInvokeTool(server, index, httpClient);
  registerAuthTools(server, httpClient);
  registerDocResources(server, index);
  registerPrompts(server);

  return server;
}
