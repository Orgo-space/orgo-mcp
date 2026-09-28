/**
 * The website builder's front door.
 *
 * Everything this tool returns is reachable through call_endpoint —
 * `GET /api/v1/website-guide` and `GET /api/v1/website-schema` are two ordinary
 * endpoints in the catalogue. It exists anyway, for one reason: discovery.
 *
 * A model decides what it can do by reading the tool list. Nothing in
 * `list_endpoints` / `describe_endpoint` / `call_endpoint` says this Orgo can
 * build and migrate a website, so an agent asked to "move our Squarespace site
 * into Orgo" has to already suspect the capability exists to go looking for it.
 * Clients that do not implement prompts or resources — several do not — have no
 * other channel. A named tool is the one surface every MCP client reads.
 *
 * It also enforces the order that matters. The expensive failure mode is an
 * agent composing blocks from guesswork and discovering the vocabulary through
 * 422s; the guide and the schema together prevent that, and one call returns
 * both.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OrgoClient } from '../lib/client.js';
import { textResult } from './shared.js';

export function registerWebsiteTools(server: McpServer, client: OrgoClient) {
  server.registerTool(
    'website_guide',
    {
      title: 'How to build or migrate a website in Orgo',
      description:
        'Read this BEFORE composing any website page, article, menu or migration. Orgo tenants have a website builder: ' +
        'pages and news articles built from a fixed vocabulary of sections, with menus, redirects, design settings, media and downloadable documents (PDF, Office, CSV) the site hosts or links from Drive. ' +
        'Returns the migration and authoring workflow (what to produce, in what order, and where to stop and ask the person) and, ' +
        'with includeSchema, the full block vocabulary — every section type with its intent, one valid example, and every allowed value. ' +
        'Both come from the running tenant, generated from the code that validates the writes, so they cannot be out of date. ' +
        'Use this for any request to move a site from WordPress, Squarespace, Wix, WildApricot, Hivebrite or NationBuilder into Orgo, ' +
        'and for any request to add or edit a page on the organisation\'s public site.',
      inputSchema: {
        includeSchema: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Also return the block vocabulary (GET /api/v1/website-schema). Several KB. Required before composing blocks; skip it if you only need the process.',
          ),
      },
    },
    async ({ includeSchema }) => {
      const guide = await client.call({
        method: 'GET',
        path: '/api/v1/website-guide',
        accept: 'text/markdown',
      });

      if (!guide.ok) {
        return textResult(explainFailure(guide.status, guide.body), true);
      }

      const parts = [
        typeof guide.body === 'string' ? guide.body : JSON.stringify(guide.body),
      ];

      if (includeSchema) {
        const schema = await client.call({
          method: 'GET',
          path: '/api/v1/website-schema',
          accept: 'application/json',
        });
        parts.push(
          schema.ok
            ? `\n\n---\n\n# The block vocabulary (GET /api/v1/website-schema)\n\n\`\`\`json\n${JSON.stringify(schema.body, null, 2)}\n\`\`\``
            : `\n\n---\n\nThe block vocabulary could not be read: ${explainFailure(schema.status, schema.body)}`,
        );
      } else {
        parts.push(
          '\n\n---\n\nCall this tool again with `includeSchema: true` before composing any block — ' +
            'the vocabulary is what the sanitizer accepts, and guessing at it costs a round of 422s.',
        );
      }

      return textResult(parts.join(''));
    },
  );
}

function explainFailure(status: number, body: unknown): string {
  const detail = typeof body === 'string' ? body : JSON.stringify(body);

  if (status === 401) {
    return 'Not authenticated (401). The website builder needs a tenant admin — an OAuth session, a JWT, or a full-access Api-Token. A scoped Api-Token cannot reach it.';
  }
  if (status === 403) {
    return (
      'Refused (403). Either this account is not an admin of the tenant, or the website module is switched off for it ' +
      '(Settings → Features → Website), or the credential is a scoped Api-Token — the whole builder is out of scope for those. ' +
      `Server said: ${detail}`
    );
  }
  if (status === 404) {
    return `Not found (404). This Orgo instance predates the website builder, or the tenant host is wrong. Server said: ${detail}`;
  }
  return `The guide could not be read (${status}). ${detail}`;
}
