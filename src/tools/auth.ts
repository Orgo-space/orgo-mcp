/**
 * Auth helper tools. These exist as first-class tools (not buried under
 * call_endpoint) because:
 *   1. They establish the *session* that everything else uses.
 *   2. OTP-based flows are interactive — the model needs to ask the user for
 *      the 6-digit code, and that's clearer with a dedicated tool than a
 *      raw HTTP call.
 *
 * Tools:
 *   whoami          → GET /api/v1/me, useful as a connection probe
 *   login           → POST /api/v1/login (email + password) → JWT pair
 *   request_otp     → POST /api/v1/request-login-otp
 *   verify_otp      → POST /api/v1/verify-login-otp → JWT pair
 *   refresh_token   → POST /api/v1/token/refresh
 *
 * These do NOT mutate the in-process auth (the env-configured token stays).
 * They return the issued tokens so the user can store them and reconfigure.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OrgoClient } from '../lib/client.js';
import { jsonResult, textResult } from './shared.js';

export function registerAuthTools(server: McpServer, client: OrgoClient) {
  server.registerTool(
    'whoami',
    {
      title: 'Return the currently authenticated user',
      description:
        'Calls GET /api/v1/me to identify the user the configured auth credentials belong to. ' +
        'Useful as a connection probe and to confirm tenant context.',
      inputSchema: {},
    },
    async () => {
      const res = await client.call({ method: 'GET', path: '/api/v1/me' });
      return jsonResult({ status: res.status, ok: res.ok, body: res.body });
    },
  );

  server.registerTool(
    'login',
    {
      title: 'Log in with email and password',
      description:
        'Exchange email + password for a JWT pair via POST /api/v1/login. The JWT is valid ~11 days. ' +
        'Returns { token, refresh_token } so the caller can persist them. ' +
        'Does NOT mutate the MCP server in-process auth — set ORGO_JWT in the env to use the issued token.',
      inputSchema: {
        username: z.string().describe('Email address.'),
        password: z.string().describe('Account password.'),
      },
    },
    async ({ username, password }) => {
      const res = await client.call({
        method: 'POST',
        path: '/api/v1/login',
        body: { username, password },
        accept: 'application/json',
        contentType: 'application/json',
      });
      return jsonResult({ status: res.status, ok: res.ok, body: res.body });
    },
  );

  server.registerTool(
    'request_otp',
    {
      title: 'Request a one-time login code by email',
      description:
        'POST /api/v1/request-login-otp — sends a 6-digit code to the given email. Rate-limited (~20/min/email). ' +
        'Follow up with `verify_otp` once the user shares the code.',
      inputSchema: {
        email: z.string().email(),
      },
    },
    async ({ email }) => {
      const res = await client.call({
        method: 'POST',
        path: '/api/v1/request-login-otp',
        body: { email },
        accept: 'application/json',
        contentType: 'application/json',
      });
      return jsonResult({ status: res.status, ok: res.ok, body: res.body });
    },
  );

  server.registerTool(
    'verify_otp',
    {
      title: 'Verify a one-time login code',
      description:
        'POST /api/v1/verify-login-otp — exchange the 6-digit code for a JWT pair. ' +
        'Returns { token, refresh_token }. Same constraints as `login`.',
      inputSchema: {
        email: z.string().email(),
        otp: z.string().describe('The 6-digit code emailed to the user.'),
      },
    },
    async ({ email, otp }) => {
      const res = await client.call({
        method: 'POST',
        path: '/api/v1/verify-login-otp',
        body: { email, otp },
        accept: 'application/json',
        contentType: 'application/json',
      });
      return jsonResult({ status: res.status, ok: res.ok, body: res.body });
    },
  );

  server.registerTool(
    'refresh_token',
    {
      title: 'Refresh a JWT',
      description:
        'POST /api/v1/token/refresh — exchange a refresh token for a fresh JWT pair. ' +
        'Use when the current JWT is approaching its 11-day expiry.',
      inputSchema: {
        refresh_token: z.string(),
      },
    },
    async ({ refresh_token }) => {
      const res = await client.call({
        method: 'POST',
        path: '/api/v1/token/refresh',
        body: { refresh_token },
        accept: 'application/json',
        contentType: 'application/json',
      });
      return jsonResult({ status: res.status, ok: res.ok, body: res.body });
    },
  );
}
