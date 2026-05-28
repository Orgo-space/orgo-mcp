/**
 * OpenAPI loader + indexer.
 *
 * Loads the enriched openapi.json at startup, then maintains lookup tables:
 *   - byOperationId(id)          → operation
 *   - byPathMethod(method, path) → operation
 *   - listByTag(tag)             → operations for that tag
 *   - findEndpoints(query)       → fuzzy search across summary/path/operationId
 *
 * The slim endpoints-index.json is what `list_endpoints` returns (small payload).
 * The full spec is what `describe_endpoint` reaches into when the model needs
 * parameter schemas, request body shape, response shape, code samples, etc.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; description?: string; version?: string };
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  tags?: { name: string; description?: string }[];
  webhooks?: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, ResponseObject>;
  security?: unknown[];
  deprecated?: boolean;
  ['x-codeSamples']?: CodeSample[];
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: unknown;
  example?: unknown;
}

export interface RequestBody {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, unknown> }>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, unknown> }>;
}

export interface CodeSample {
  lang: string;
  label?: string;
  source: string;
}

export interface EndpointIndexEntry {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  hasBody: boolean;
  deprecated: boolean;
}

export interface TagEntry {
  name: string;
  description: string;
}

export interface WebhookIndexEntry {
  event: string;
  summary: string;
  description: string;
}

export class OpenApiIndex {
  readonly spec: OpenApiSpec;
  readonly endpoints: EndpointIndexEntry[];
  readonly tags: TagEntry[];
  readonly webhookIndex: WebhookIndexEntry[];

  private readonly byId = new Map<string, { method: string; path: string; op: Operation }>();
  private readonly byPathMethod = new Map<string, Operation>();
  private readonly byTag = new Map<string, EndpointIndexEntry[]>();

  constructor() {
    this.spec = JSON.parse(readFileSync(join(dataDir, 'openapi.json'), 'utf8')) as OpenApiSpec;
    this.endpoints = JSON.parse(readFileSync(join(dataDir, 'endpoints-index.json'), 'utf8')) as EndpointIndexEntry[];
    this.tags = JSON.parse(readFileSync(join(dataDir, 'tags-index.json'), 'utf8')) as TagEntry[];
    this.webhookIndex = JSON.parse(readFileSync(join(dataDir, 'webhooks-index.json'), 'utf8')) as WebhookIndexEntry[];

    for (const [path, methods] of Object.entries(this.spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(method)) continue;
        const key = pathMethodKey(method, path);
        this.byPathMethod.set(key, op);
        if (op.operationId) this.byId.set(op.operationId, { method: method.toUpperCase(), path, op });
      }
    }

    for (const e of this.endpoints) {
      const bucket = this.byTag.get(e.tag) ?? [];
      bucket.push(e);
      this.byTag.set(e.tag, bucket);
    }
  }

  findOperation(method: string, path: string): Operation | undefined {
    return this.byPathMethod.get(pathMethodKey(method, path));
  }

  findById(operationId: string): { method: string; path: string; op: Operation } | undefined {
    return this.byId.get(operationId);
  }

  listByTag(tag: string): EndpointIndexEntry[] {
    return this.byTag.get(tag) ?? [];
  }

  searchEndpoints(opts: {
    query?: string;
    tag?: string;
    method?: string;
    limit?: number;
  }): EndpointIndexEntry[] {
    const limit = opts.limit ?? 50;
    const q = opts.query?.toLowerCase().trim();
    const tag = opts.tag?.trim();
    const method = opts.method?.toUpperCase().trim();

    let pool: EndpointIndexEntry[] = this.endpoints;
    if (tag) pool = pool.filter((e) => e.tag.toLowerCase() === tag.toLowerCase());
    if (method) pool = pool.filter((e) => e.method === method);
    if (q) {
      pool = pool.filter(
        (e) =>
          e.path.toLowerCase().includes(q) ||
          e.summary.toLowerCase().includes(q) ||
          e.operationId.toLowerCase().includes(q) ||
          e.tag.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    return pool.slice(0, limit);
  }

  findTag(name: string): TagEntry | undefined {
    return this.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  findWebhook(event: string): { summary: string; description: string; op?: Operation } | undefined {
    const idx = this.webhookIndex.find((w) => w.event === event);
    if (!idx) return undefined;
    const op = this.spec.webhooks?.[event]?.post;
    return { summary: idx.summary, description: idx.description, op };
  }
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function pathMethodKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
