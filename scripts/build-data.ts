/**
 * Reads the enriched OpenAPI spec + Mintlify markdown docs from the local
 * orgo/api-docs repo and writes a slim, MCP-shaped data bundle into src/data/.
 *
 * Source of truth: /Users/alex/api-docs (override with ORGO_DOCS_REPO env var).
 *
 * Output:
 *   src/data/openapi.json          - the full enriched spec (copied verbatim)
 *   src/data/endpoints-index.json  - { operationId, method, path, tag, summary, hasBody }[]
 *   src/data/tags-index.json       - { name, description }[] (from tags.yaml)
 *   src/data/webhooks-index.json   - { event, summary, description }[] (from webhooks.yaml)
 *   src/data/docs/concepts/*.mdx   - copied verbatim
 *   src/data/docs/recipes/*.mdx    - copied verbatim
 *   src/data/info.md               - the API overview prose
 *
 * Re-run after pulling fresh docs:  npm run build:data
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..');
const dataDir = join(repoRoot, 'src', 'data');
const docsRepo = process.env.ORGO_DOCS_REPO ?? '/Users/alex/api-docs';

if (!existsSync(docsRepo)) {
  console.error(`[build-data] Docs repo not found at ${docsRepo}.`);
  console.error(`[build-data] Set ORGO_DOCS_REPO to point at your local orgo/api-docs checkout.`);
  process.exit(1);
}

// Wipe + recreate output dirs
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(join(dataDir, 'docs', 'concepts'), { recursive: true });
mkdirSync(join(dataDir, 'docs', 'recipes'), { recursive: true });

// 1) Copy the enriched OpenAPI spec
const openapiSrc = join(docsRepo, 'api-reference', 'openapi.json');
const openapiDst = join(dataDir, 'openapi.json');
copyFileSync(openapiSrc, openapiDst);
const spec = JSON.parse(readFileSync(openapiDst, 'utf8')) as OpenApiSpec;
console.log(`[build-data] copied openapi.json (${spec.info.title}, ${Object.keys(spec.paths ?? {}).length} paths)`);

// 2) Build a slim endpoint index for fast list_endpoints/describe_endpoint lookups
const endpoints: EndpointIndexEntry[] = [];
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  if (!methods || typeof methods !== 'object') continue;
  for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const operation = op as OpenApiOperation;
    endpoints.push({
      operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`,
      method: method.toUpperCase(),
      path,
      tag: operation.tags?.[0] ?? 'Untagged',
      summary: operation.summary ?? '',
      description: truncate(operation.description ?? '', 600),
      hasBody: Boolean(operation.requestBody),
      deprecated: Boolean(operation.deprecated),
    });
  }
}
endpoints.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
writeFileSync(join(dataDir, 'endpoints-index.json'), JSON.stringify(endpoints, null, 2));
console.log(`[build-data] wrote endpoints-index.json (${endpoints.length} operations)`);

// 3) Tag descriptions (from spec.tags, which postprocess-openapi.py populated from tags.yaml)
const tags: TagIndexEntry[] = (spec.tags ?? []).map((t) => ({
  name: t.name,
  description: t.description ?? '',
}));
writeFileSync(join(dataDir, 'tags-index.json'), JSON.stringify(tags, null, 2));
console.log(`[build-data] wrote tags-index.json (${tags.length} tags)`);

// 4) Webhooks (from spec.webhooks, populated from webhooks.yaml)
const webhooks: WebhookIndexEntry[] = [];
for (const [event, methods] of Object.entries(spec.webhooks ?? {})) {
  const post = (methods as { post?: OpenApiOperation })?.post;
  if (!post) continue;
  webhooks.push({
    event,
    summary: post.summary ?? '',
    description: post.description ?? '',
  });
}
writeFileSync(join(dataDir, 'webhooks-index.json'), JSON.stringify(webhooks, null, 2));
console.log(`[build-data] wrote webhooks-index.json (${webhooks.length} events)`);

// 5) Copy concept + recipe markdown
copyMdxDir(join(docsRepo, 'api-reference', 'concepts'), join(dataDir, 'docs', 'concepts'));
copyMdxDir(join(docsRepo, 'api-reference', 'recipes'), join(dataDir, 'docs', 'recipes'));

// 6) info.md (overview prose) for the resource that introduces the API
const infoSrc = join(docsRepo, 'scripts', 'enrichment-data', 'info.md');
if (existsSync(infoSrc)) {
  copyFileSync(infoSrc, join(dataDir, 'info.md'));
  console.log(`[build-data] copied info.md`);
}

console.log(`[build-data] done -> ${dataDir}`);

// ─────────────────────────── helpers ────────────────────────────

function copyMdxDir(from: string, to: string) {
  if (!existsSync(from)) return;
  let n = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mdx') && !entry.name.endsWith('.md')) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
    n++;
  }
  console.log(`[build-data] copied ${n} files from ${basename(from)}/`);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// ─────────────────────────── types ──────────────────────────────

interface OpenApiSpec {
  info: { title: string; description?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  tags?: { name: string; description?: string }[];
  webhooks?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  requestBody?: unknown;
  deprecated?: boolean;
}

interface EndpointIndexEntry {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  hasBody: boolean;
  deprecated: boolean;
}

interface TagIndexEntry {
  name: string;
  description: string;
}

interface WebhookIndexEntry {
  event: string;
  summary: string;
  description: string;
}
