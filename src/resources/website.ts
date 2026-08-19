/**
 * The website builder's two live documents, as MCP resources.
 *
 * Unlike everything in docs.ts, these are not files shipped in the package.
 * They are fetched from the tenant on read, because both are generated from the
 * running code — the guide ships with the endpoints it describes, and the block
 * vocabulary is generated from the sanitizer that validates the writes. A copy
 * bundled here would be a second source of truth that goes stale silently,
 * which for a vocabulary means an agent composing sections the server then
 * drops.
 *
 * The same content is behind the `website_guide` tool. Both exist because MCP
 * clients differ: Claude Desktop and Claude.ai surface resources in the "@"
 * menu so a person can attach the vocabulary to a conversation deliberately,
 * while several other clients implement tools only.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OrgoClient } from '../lib/client.js';

export function registerWebsiteResources(server: McpServer, client: OrgoClient) {
  server.registerResource(
    'website-guide',
    'orgo://website/guide',
    {
      title: 'Orgo website: the migration and authoring workflow',
      description:
        'How to move a website into Orgo or author one: the SiteSpec shape, the phases, the mapping table, and the two points where you stop and ask the person. Read before composing anything.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const res = await client.call({
        method: 'GET',
        path: '/api/v1/website-guide',
        accept: 'text/markdown',
      });
      const text = res.ok
        ? String(res.body)
        : `The guide could not be read (${res.status}). It needs a tenant admin credential and the website module enabled.`;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  server.registerResource(
    'website-schema',
    'orgo://website/schema',
    {
      title: 'Orgo website: the block vocabulary',
      description:
        'Every section type a page or article may contain, with its intent, one valid example and every allowed value — plus which system blocks this tenant may use. Generated from the sanitizer, so it is exactly what a save accepts.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const res = await client.call({
        method: 'GET',
        path: '/api/v1/website-schema',
        accept: 'application/json',
      });
      const text = res.ok
        ? JSON.stringify(res.body, null, 2)
        : JSON.stringify(
            {
              error: `The block vocabulary could not be read (${res.status}).`,
              detail: res.body,
            },
            null,
            2,
          );
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );
}
