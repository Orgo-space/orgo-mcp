/**
 * MCP resources: the hand-written documentation Orgo publishes on its docs site,
 * exposed inside the MCP so the model can `resources/read` them when stuck.
 *
 * URI scheme:
 *   orgo://docs/overview                            — the API overview prose
 *   orgo://docs/concepts/{slug}                     — authentication, tenancy, errors, ...
 *   orgo://docs/recipes/{slug}                      — onboard-a-member, sell-tickets, ...
 *   orgo://docs/tags                                — full tag catalog (entity descriptions)
 *   orgo://docs/webhooks                            — webhook event index
 *
 * Resources are listed in `resources/list` and read via `resources/read`. They
 * surface in Claude Desktop's "@ mentions" menu so the user can attach them to
 * the chat explicitly.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenApiIndex } from '../lib/openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

export function registerDocResources(server: McpServer, index: OpenApiIndex) {
  // 1) Overview: a single fixed-URI resource
  server.registerResource(
    'api-overview',
    'orgo://docs/overview',
    {
      title: 'Orgo API overview',
      description: 'High-level introduction to the Orgo API: base URL, auth methods, tenant model, content types, pagination, errors.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const text = readIfExists(join(dataDir, 'info.md')) ?? 'Overview not bundled.';
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  // 2) Concept docs (7 templated)
  const conceptSlugs = listSlugs(join(dataDir, 'docs', 'concepts'));
  server.registerResource(
    'concept-doc',
    new ResourceTemplate('orgo://docs/concepts/{slug}', {
      list: async () => ({
        resources: conceptSlugs.map((slug) => ({
          uri: `orgo://docs/concepts/${slug}`,
          name: `concept: ${slug}`,
          description: `Orgo API concept — ${slug.replace(/-/g, ' ')}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Orgo API concept docs',
      description: 'authentication, tenancy, errors, pagination-and-filters, rate-limits, content-types, webhooks.',
      mimeType: 'text/markdown',
    },
    async (uri, { slug }) => {
      const file = join(dataDir, 'docs', 'concepts', `${slug}.mdx`);
      const text = readIfExists(file) ?? `Concept "${slug}" not bundled. Try one of: ${conceptSlugs.join(', ')}.`;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  // 3) Recipes (11 templated)
  const recipeSlugs = listSlugs(join(dataDir, 'docs', 'recipes'));
  server.registerResource(
    'recipe-doc',
    new ResourceTemplate('orgo://docs/recipes/{slug}', {
      list: async () => ({
        resources: recipeSlugs.map((slug) => ({
          uri: `orgo://docs/recipes/${slug}`,
          name: `recipe: ${slug}`,
          description: `End-to-end Orgo recipe — ${slug.replace(/-/g, ' ')}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Orgo recipes',
      description:
        'Goal-oriented walkthroughs: onboard a member, sell event tickets, send a newsletter, run a board election, etc.',
      mimeType: 'text/markdown',
    },
    async (uri, { slug }) => {
      const file = join(dataDir, 'docs', 'recipes', `${slug}.mdx`);
      const text = readIfExists(file) ?? `Recipe "${slug}" not bundled. Try one of: ${recipeSlugs.join(', ')}.`;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  // 4) Tag catalog as a single document — what every resource family means
  server.registerResource(
    'tag-catalog',
    'orgo://docs/tags',
    {
      title: 'Orgo resource catalog',
      description: 'All 118 resource families with descriptions and lifecycle notes.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const lines: string[] = ['# Orgo resource catalog', ''];
      for (const t of index.tags) {
        const count = index.listByTag(t.name).length;
        lines.push(`## ${t.name} (${count} endpoint${count === 1 ? '' : 's'})`);
        lines.push('');
        lines.push(t.description || '_No description._');
        lines.push('');
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    },
  );

  // 5) Webhook catalog
  server.registerResource(
    'webhook-catalog',
    'orgo://docs/webhooks',
    {
      title: 'Orgo webhook events',
      description: 'All 18 webhook events with summaries.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const lines: string[] = ['# Orgo webhook events', ''];
      for (const w of index.webhookIndex) {
        lines.push(`## ${w.event}`);
        lines.push('');
        lines.push(w.summary || '');
        lines.push('');
        if (w.description) {
          lines.push(w.description);
          lines.push('');
        }
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    },
  );
}

function listSlugs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
    .map((f) => f.replace(/\.(mdx|md)$/, ''))
    .sort();
}

function readIfExists(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}
