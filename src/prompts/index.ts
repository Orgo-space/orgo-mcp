/**
 * MCP prompts: reusable templates that compose the tools + recipe docs into
 * common end-to-end workflows. Users see these in Claude Desktop's slash-command
 * menu and can launch them with a single click.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'onboard-member',
    {
      title: 'Onboard a new Orgo member',
      description: 'Walks through the full adhesion (membership application) flow end to end.',
      argsSchema: {
        email: z.string().email().describe('Email of the candidate to onboard.'),
        localCenterId: z.string().optional().describe('Local center ID to assign them to (optional).'),
      },
    },
    ({ email, localCenterId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Onboard a new Orgo member with email ${email}` +
              (localCenterId ? ` in local center ${localCenterId}` : '') +
              `. First read the resource orgo://docs/recipes/onboard-a-new-member so you follow the documented flow exactly. ` +
              `Then walk me through each step (create adhesion, upload ID, submit for review) by calling the relevant endpoints. ` +
              `Ask me before transitioning state.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'sell-event-tickets',
    {
      title: 'Create and sell event tickets',
      description: 'Sets up a ticketed event with product prices, public landing page, and Stripe checkout.',
      argsSchema: {
        eventName: z.string().describe('Name of the event.'),
        startDate: z.string().describe('ISO 8601 start datetime, e.g. 2026-09-15T18:00:00Z'),
      },
    },
    ({ eventName, startDate }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want to create an event called "${eventName}" starting ${startDate} and sell tickets to it. ` +
              `Read orgo://docs/recipes/create-and-sell-event-tickets first. Then walk me through creating the event, defining product prices, ` +
              `publishing the public landing page, and confirming the Stripe checkout flow works.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'find-endpoint',
    {
      title: 'Find the right endpoint for a goal',
      description: 'Given a natural-language goal, use list_endpoints + describe_endpoint to identify the right operation(s).',
      argsSchema: {
        goal: z.string().describe('What you are trying to accomplish, in plain language.'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\n\n` +
              `Find the right Orgo endpoint(s) for this. Use list_endpoints with a query, then describe_endpoint on the top candidates. ` +
              `If the goal touches multiple resources, list_resources first to orient. ` +
              `Show me the chosen endpoint(s) with their full parameter list before we call anything.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'sync-crm',
    {
      title: 'Sync members/contacts with an external CRM',
      description: 'Use the sync-your-crm-with-orgo recipe to design and run a one-way or two-way sync.',
      argsSchema: {
        targetCrm: z.string().describe('Name of the external CRM, e.g. HubSpot, Salesforce, Pipedrive.'),
        direction: z.enum(['orgo-to-crm', 'crm-to-orgo', 'two-way']).describe('Sync direction.'),
      },
    },
    ({ targetCrm, direction }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Read orgo://docs/recipes/sync-your-crm-with-orgo. ` +
              `Then design a ${direction} sync between Orgo and ${targetCrm}. ` +
              `Identify which Orgo entities map to which ${targetCrm} objects, which webhooks to subscribe to, and which list/filter calls to schedule.`,
          },
        },
      ],
    }),
  );
}
