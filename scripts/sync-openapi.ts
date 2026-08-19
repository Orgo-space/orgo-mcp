/**
 * Merges paths from a live Orgo OpenAPI export into the bundled spec.
 *
 * Why this exists alongside build-data.ts. That script rebuilds src/data/ from
 * the api-docs repo, which is where the hand-written tag descriptions, concept
 * pages, recipes and code samples live. It is the right tool when the docs have
 * moved, and the wrong one when the *API* has: a feature shipped in
 * orgo-platform reaches api-docs only after someone re-runs the docs
 * generation, and until then the MCP cannot call it at all — call_endpoint
 * validates against this catalogue and refuses what it does not find.
 *
 * So this is the other direction: take an export straight from the API and add
 * what the bundle is missing, without touching what api-docs enriched. It is
 * additive by design. An operation already in the bundle is left alone unless
 * --overwrite says otherwise, because the bundled copy is usually the better
 * one — same operation, plus a curated description and code samples.
 *
 * Usage:
 *   # from a file (bin/console api:openapi:export --spec-version=3 > spec.json)
 *   npm run sync:spec -- --from ./spec.json --only '^/api/v1/website'
 *
 *   # from a running instance
 *   npm run sync:spec -- --from https://acme.orgo.space/api/v1/docs.json
 *
 * Flags:
 *   --from <file|url>   required. The source spec.
 *   --only <regex>      only merge paths matching it. Omit to merge everything.
 *   --overwrite         replace operations that already exist in the bundle.
 *   --dry               report what would change and write nothing.
 *
 * Always rebuilds endpoints-index.json and tags-index.json from the merged
 * spec, so the three files cannot disagree about what exists.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(resolve(here, '..'), 'src', 'data');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  requestBody?: unknown;
  deprecated?: boolean;
}

interface Spec {
  paths?: Record<string, Record<string, Operation>>;
  tags?: { name: string; description?: string }[];
  components?: { schemas?: Record<string, unknown> };
  [k: string]: unknown;
}

const args = parseArgs(process.argv.slice(2));
if (!args.from) {
  console.error('sync-openapi: --from <file|url> is required.');
  process.exit(1);
}

const only = args.only ? new RegExp(args.only) : null;

const base = JSON.parse(readFileSync(join(dataDir, 'openapi.json'), 'utf8')) as Spec;
const source = (await load(args.from)) as Spec;

const added: string[] = [];
const replaced: string[] = [];
const skipped: string[] = [];

base.paths ??= {};

for (const [path, item] of Object.entries(source.paths ?? {})) {
  if (only && !only.test(path)) continue;
  if (!item || typeof item !== 'object') continue;

  for (const [method, op] of Object.entries(item)) {
    if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;

    const exists = base.paths[path]?.[method] !== undefined;
    if (exists && !args.overwrite) {
      skipped.push(`${method.toUpperCase()} ${path}`);
      continue;
    }

    base.paths[path] ??= {};
    base.paths[path][method] = op;
    (exists ? replaced : added).push(`${method.toUpperCase()} ${path}`);
  }

  // Path-level members the operations rely on (parameters, servers, $ref).
  for (const [key, value] of Object.entries(item)) {
    if (HTTP_METHODS.includes(key as (typeof HTTP_METHODS)[number])) continue;
    base.paths[path] ??= {};
    (base.paths[path] as Record<string, unknown>)[key] ??= value;
  }
}

// Schemas the merged operations reference, transitively. Copying the source's
// whole components section instead would pull in several hundred schemas for
// endpoints we did not merge, and quietly overwrite enriched ones.
const schemaAdds = copyReferencedSchemas(base, source, [...added, ...replaced]);

// Tags: add ones the bundle lacks, and fill in a description where the bundle
// has the tag but no text. Never replace an existing description — that is
// what api-docs curates.
const tagAdds: string[] = [];
const tagFills: string[] = [];
base.tags ??= [];
for (const tag of source.tags ?? []) {
  const existing = base.tags.find((t) => t.name === tag.name);
  if (!existing) {
    if (usesTag(base, tag.name)) {
      base.tags.push(tag);
      tagAdds.push(tag.name);
    }
    continue;
  }
  if (!existing.description?.trim() && tag.description?.trim()) {
    existing.description = tag.description;
    tagFills.push(tag.name);
  }
}

report();

if (args.dry) {
  console.log('\n[sync-openapi] --dry: nothing written.');
  process.exit(0);
}

writeFileSync(join(dataDir, 'openapi.json'), JSON.stringify(base, null, 2));
rebuildIndexes(base);

console.log('\n[sync-openapi] wrote openapi.json, endpoints-index.json, tags-index.json');

// ─────────────────────────── helpers ────────────────────────────

function report() {
  console.log(`[sync-openapi] source: ${args.from}${only ? `  filter: ${only}` : ''}`);
  console.log(`[sync-openapi] added ${added.length} operation(s)`);
  for (const a of added) console.log(`  + ${a}`);
  if (replaced.length) {
    console.log(`[sync-openapi] replaced ${replaced.length} operation(s)`);
    for (const r of replaced) console.log(`  ~ ${r}`);
  }
  if (skipped.length) {
    console.log(`[sync-openapi] left alone ${skipped.length} operation(s) already bundled (use --overwrite to replace)`);
  }
  if (schemaAdds.length) console.log(`[sync-openapi] added ${schemaAdds.length} referenced schema(s)`);
  if (tagAdds.length) console.log(`[sync-openapi] added tag(s): ${tagAdds.join(', ')}`);
  if (tagFills.length) console.log(`[sync-openapi] filled empty tag description(s): ${tagFills.join(', ')}`);
}

async function load(from: string): Promise<unknown> {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${from} -> ${res.status} ${res.statusText}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(resolve(from), 'utf8'));
}

function usesTag(spec: Spec, name: string): boolean {
  for (const item of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
      if ((op as Operation).tags?.includes(name)) return true;
    }
  }
  return false;
}

/** Walk $refs from the merged operations and copy any schema the bundle lacks. */
function copyReferencedSchemas(target: Spec, src: Spec, merged: string[]): string[] {
  const srcSchemas = src.components?.schemas ?? {};
  if (Object.keys(srcSchemas).length === 0) return [];

  target.components ??= {};
  target.components.schemas ??= {};
  const have = target.components.schemas;

  const pending: string[] = [];
  for (const entry of merged) {
    const [method, path] = entry.split(' ');
    const op = target.paths?.[path]?.[method.toLowerCase()];
    if (op) pending.push(...refsIn(op));
  }

  const copied: string[] = [];
  const seen = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (have[name] !== undefined) continue;
    const schema = srcSchemas[name];
    if (schema === undefined) continue;
    have[name] = schema;
    copied.push(name);
    pending.push(...refsIn(schema));
  }
  return copied;
}

function refsIn(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = v.match(/^#\/components\/schemas\/(.+)$/);
        if (m) out.push(m[1]);
        continue;
      }
      walk(v);
    }
  };
  walk(node);
  return out;
}

/** Same shape build-data.ts writes, so the two scripts stay interchangeable. */
function rebuildIndexes(spec: Spec) {
  const endpoints: Record<string, unknown>[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
      endpoints.push({
        operationId: op.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? 'Untagged',
        summary: op.summary ?? '',
        description: truncate(op.description ?? '', 600),
        hasBody: Boolean(op.requestBody),
        deprecated: Boolean(op.deprecated),
      });
    }
  }
  endpoints.sort(
    (a, b) =>
      String(a.tag).localeCompare(String(b.tag)) ||
      String(a.path).localeCompare(String(b.path)) ||
      String(a.method).localeCompare(String(b.method)),
  );
  writeFileSync(join(dataDir, 'endpoints-index.json'), JSON.stringify(endpoints, null, 2));

  const tags = (spec.tags ?? []).map((t) => ({ name: t.name, description: t.description ?? '' }));
  writeFileSync(join(dataDir, 'tags-index.json'), JSON.stringify(tags, null, 2));

  console.log(`[sync-openapi] indexes: ${endpoints.length} operations, ${tags.length} tags`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function parseArgs(argv: string[]) {
  const out: { from?: string; only?: string; overwrite: boolean; dry: boolean } = {
    overwrite: false,
    dry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':
        out.from = argv[++i];
        break;
      case '--only':
        out.only = argv[++i];
        break;
      case '--overwrite':
        out.overwrite = true;
        break;
      case '--dry':
        out.dry = true;
        break;
      default:
        console.error(`sync-openapi: unknown argument "${argv[i]}"`);
        process.exit(1);
    }
  }
  return out;
}
