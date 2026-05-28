/**
 * Structured JSON logger. Designed for CloudWatch / Loki / Vector ingestion:
 * one JSON object per line, all timestamps ISO-8601, levels lowercase.
 *
 * Bearer-redaction rule: any log field named `authorization`, `bearer`,
 * `token`, or `api-token` is redacted to `<redacted:<8-hex-prefix-of-sha256>>`
 * so we can correlate the same token across log lines without ever logging
 * its plaintext value.
 */

import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEYS = new Set(['authorization', 'bearer', 'token', 'api-token', 'api_token', 'apitoken']);

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(service = 'orgo-mcp-http'): Logger {
  const minLevel = (process.env.ORGO_LOG_LEVEL?.trim().toLowerCase() as LogLevel) || 'info';
  const minOrdinal = ordinal(minLevel);

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ordinal(level) < minOrdinal) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...sanitize(fields ?? {}),
    });
    // stderr keeps stdout clean for any process supervisor that captures it.
    process.stderr.write(line + '\n');
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

function ordinal(level: LogLevel): number {
  switch (level) {
    case 'debug':
      return 0;
    case 'info':
      return 1;
    case 'warn':
      return 2;
    case 'error':
      return 3;
  }
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = redact(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redact(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return '<redacted>';
  const hex = createHash('sha256').update(v).digest('hex').slice(0, 8);
  return `<redacted:${hex}>`;
}
