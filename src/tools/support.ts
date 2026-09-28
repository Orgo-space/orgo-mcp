/**
 * Support tool surface. This is everything Fin can reach.
 *
 * One tool, search only. There is deliberately no list-all, no get-by-id, no
 * cursor and no debug endpoint: an attacker who reaches this server through a
 * chat conversation can sample the index but cannot systematically dump it.
 * Adding an enumeration endpoint later would quietly remove that property, so
 * treat this file's minimalism as load-bearing.
 *
 * The response shape is enforced here, at the tool-call layer, rather than asked
 * for in a prompt. A model does not get a vote on what fields exist.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactsIndex } from '../lib/facts-index.js';
import { AREAS } from '../lib/gate.js';
import { jsonResult } from './shared.js';

export interface SupportToolDeps {
  index: FactsIndex;
  /** Called for every query. Used for rate-limit accounting and probe detection. */
  onQuery?: (query: string, resultCount: number) => void;
}

export function registerSupportTools(server: McpServer, { index, onQuery }: SupportToolDeps): void {
  server.registerTool(
    'search_behavior_facts',
    {
      title: 'Search Orgo behaviour facts',
      description:
        'Look up verified facts about how the Orgo platform behaves — configuration effects, ' +
        'edge conditions, and interactions between settings that are too conditional for the ' +
        'public documentation. Use this when the documentation does not answer an administrator ' +
        'question about product behaviour.\n\n' +
        'Returns at most three short, customer-safe answers. An empty result means no verified ' +
        'fact covers the question: hand the conversation to a human rather than inferring an answer. ' +
        'This index contains no customer or organisation data and cannot answer questions about a ' +
        'specific organisation, member, or payment.',
      inputSchema: {
        query: z
          .string()
          .min(3)
          .max(300)
          .describe("The administrator's question, in their own words."),
        area: z
          .enum(AREAS as unknown as [string, ...string[]])
          .optional()
          .describe('Optional area filter. Omit unless the question is clearly scoped to one.'),
      },
    },
    async ({ query, area }) => {
      const hits = index.search(query, area);
      onQuery?.(query, hits.length);

      // Scores are internal ranking detail and are not returned: they would leak
      // information about non-matching entries across repeated probing queries.
      return jsonResult({
        results: hits.map((h) => ({
          id: h.fact.id,
          answer: h.fact.answer,
          area: h.fact.area,
        })),
        ...(hits.length === 0
          ? { note: 'No verified fact covers this question. Hand off to a human; do not infer an answer.' }
          : {}),
      });
    },
  );
}
