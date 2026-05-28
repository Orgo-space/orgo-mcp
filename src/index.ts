#!/usr/bin/env node
/**
 * stdio entry. The MCP standard local transport — what Claude Desktop and
 * `claude` (CLI) speak by default. Each spawn is a single session.
 *
 * Usage:
 *   ORGO_TENANT_HOST=acme.orgo.space ORGO_API_TOKEN=... npx orgo-mcp
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "orgo": {
 *         "command": "npx",
 *         "args": ["-y", "orgo-mcp"],
 *         "env": {
 *           "ORGO_TENANT_HOST": "acme.orgo.space",
 *           "ORGO_API_TOKEN": "..."
 *         }
 *       }
 *     }
 *   }
 *
 * For a hosted server with OAuth, see src/http.ts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, describeAuth } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const server = buildServer({ config });

  // Log to stderr so we don't pollute the stdio MCP channel on stdout.
  console.error(`[orgo-mcp] connecting to ${config.baseUrl}`);
  console.error(`[orgo-mcp] auth: ${describeAuth(config.auth)}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[orgo-mcp] ready on stdio');
}

main().catch((err) => {
  console.error('[orgo-mcp] fatal:', err);
  process.exit(1);
});
