#!/usr/bin/env node
/**
 * Asserts that the support server cannot reach the Orgo API.
 *
 * The security argument for the support MCP is that a process reachable from a
 * public chat conversation holds no code, no citations and no route to customer
 * data. Two of those are enforced by `build-facts.ts`. This script enforces the
 * third, by walking the actual module graph of the built entry point rather than
 * trusting that nobody adds an import.
 *
 * Walking the graph rather than grepping the file matters: a transitive import
 * three modules deep is exactly the kind of thing review misses, and exactly the
 * kind of thing that silently reconnects the data path.
 *
 * Run after `tsc`:  node scripts/check-support-isolation.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// Entry is overridable so the check can be exercised against a bundle that is
// *supposed* to fail (dist/http.js). A guard nobody has seen fail is a guard
// nobody knows works.
const ENTRY = resolve(ROOT, process.argv[2] ?? 'dist/support.js');

/**
 * Modules that would give this process a path to the Orgo API, tenant data, or
 * an OAuth identity. Reaching any of them is a build failure, not a warning.
 */
const FORBIDDEN = [
  'dist/lib/client.js',
  'dist/auth/oauth.js',
  'dist/server.js',
  'dist/config.js',
  'dist/lib/tenant.js',
  'dist/tools/invoke.js',
  'dist/tools/auth.js',
  'dist/tools/discovery.js',
  'dist/http.js',
];

/** Identifiers that should never appear in the bundle, whatever the import path. */
const FORBIDDEN_SYMBOLS = ['OrgoClient', 'OAuthValidator', 'resolveTenant'];

if (!existsSync(ENTRY)) {
  console.error(`[isolation] ${relative(ROOT, ENTRY)} not found. Run "npm run build" first.`);
  process.exit(1);
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const visited = new Set();
const sources = new Map();

function walk(file) {
  const abs = resolve(file);
  if (visited.has(abs)) return;
  if (!existsSync(abs)) return;

  visited.add(abs);
  const src = readFileSync(abs, 'utf8');
  sources.set(abs, src);

  for (const pattern of [IMPORT, DYNAMIC]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(src)) !== null) {
      walk(resolve(dirname(abs), match[1]));
    }
  }
}

walk(ENTRY);

const failures = [];

for (const forbidden of FORBIDDEN) {
  const abs = resolve(ROOT, forbidden);
  if (visited.has(abs)) {
    failures.push(`reachable module: ${forbidden}`);
  }
}

for (const [file, src] of sources) {
  for (const symbol of FORBIDDEN_SYMBOLS) {
    if (src.includes(symbol)) {
      failures.push(`symbol "${symbol}" present in ${relative(ROOT, file)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('\n[isolation] FAILED. The support bundle can reach the Orgo API.\n');
  failures.forEach((f) => console.error(`  ${f}`));
  console.error('\nThe support server is reachable from a public chat conversation.');
  console.error('It must hold no route to customer data. Remove the import, do not suppress this check.\n');
  process.exit(1);
}

console.log(`[isolation] ok — ${visited.size} module(s) reachable from dist/support.js, none forbidden`);
