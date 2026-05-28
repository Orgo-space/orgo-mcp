/**
 * Shared helpers for MCP tool callbacks.
 *
 * MCP tool results have a tight shape: `{ content: [{ type: 'text', text }], isError? }`.
 * These helpers keep call sites short and consistent.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}
