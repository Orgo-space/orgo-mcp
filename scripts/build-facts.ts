/**
 * Compiles reviewed behaviour facts into the artefact the public support MCP
 * is allowed to hold.
 *
 *   support-facts/*.md        (private, carries citations, human-reviewed)
 *        │
 *        ├─ parse            → FactSource
 *        ├─ gate             → reject on any violation, never sanitise
 *        ├─ project          → { id, answer, area, asks }
 *        └─ final sweep      → re-scan the serialised blob
 *        ↓
 *   facts.serve.json         (mounted at runtime; no citation, no code, no paths)
 *
 * Fails the build rather than warning. A warning that ships is not a control.
 *
 * Usage:
 *   node --import tsx scripts/build-facts.ts [--in <dir>] [--out <file>]
 *
 * The sources carry citations into a private codebase, so they do not live in
 * this public repository. Point ORGO_FACTS_DIR (or --in) at them.
 *
 * Defaults:
 *   --in   $ORGO_FACTS_DIR, else ./support-facts (missing = empty index)
 *   --out  ./facts.serve.json (gitignored)
 *
 * The output deliberately stays out of src/data: `npm run build` copies that
 * directory into dist/, which ships in the npm package and the public image.
 * The support image carries no facts either. They are mounted at runtime.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { parseFact, toServed, FactParseError, type FactSource, type ServedFact } from '../src/lib/facts.js';
import { gateAnswer, gateMeta, type Violation } from '../src/lib/gate.js';

const DEFAULT_IN = process.env.ORGO_FACTS_DIR ?? 'support-facts';
const DEFAULT_OUT = resolve(import.meta.dirname, '../facts.serve.json');

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Rejection {
  file: string;
  violations: Violation[];
}

function main(): void {
  const inDir = resolve(arg('--in', DEFAULT_IN));
  const outFile = resolve(arg('--out', DEFAULT_OUT));

  if (!existsSync(inDir)) {
    // Not an error: the index legitimately starts empty, and facts are promoted
    // from real escalations rather than authored up front.
    console.log(`[facts] no fact directory at ${inDir}, writing empty index`);
    write(outFile, []);
    return;
  }

  const files = readdirSync(inDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const accepted: ServedFact[] = [];
  const rejected: Rejection[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const path = join(inDir, file);
    let fact: FactSource;

    try {
      fact = parseFact(readFileSync(path, 'utf8'), file);
    } catch (err) {
      const message = err instanceof FactParseError ? err.message : String(err);
      rejected.push({ file, violations: [{ rule: 'parse', detail: message }] });
      continue;
    }

    const violations: Violation[] = [
      ...gateMeta({ id: fact.id, area: fact.area, verifiedInApp: fact.verifiedInApp }).violations,
      ...gateAnswer(fact.answer).violations,
    ];

    // `asks` is indexed for retrieval, so it is served and must clear the same bar.
    for (const v of gateAnswer(fact.asks, { maxWords: 20 }).violations) {
      violations.push({ rule: `asks.${v.rule}`, detail: v.detail });
    }

    const previous = seenIds.get(fact.id);
    if (previous) {
      violations.push({ rule: 'meta.duplicate-id', detail: `id "${fact.id}" already used by ${previous}` });
    } else {
      seenIds.set(fact.id, file);
    }

    if (violations.length > 0) {
      rejected.push({ file, violations });
      continue;
    }

    accepted.push(toServed(fact));
  }

  if (rejected.length > 0) {
    report(rejected);
    process.exit(1);
  }

  // Final sweep. Catches content that reached the output through a field this
  // script does not know about — a projection bug, or a `FactSource` field added
  // without updating `toServed`.
  //
  // Sweeps the concatenated *values*, not the serialised JSON: the envelope's own
  // braces and quotes would otherwise trip the syntax rules on every build.
  const values = accepted.flatMap((f) => Object.values(f).filter((v): v is string => typeof v === 'string'));
  const sweep = gateAnswer(values.join('\n'), { maxWords: Number.MAX_SAFE_INTEGER });
  if (sweep.violations.length > 0) {
    console.error('[facts] FATAL: projected values tripped the gate.');
    console.error('        This means the projection leaked. Do not ship this build.');
    sweep.violations.forEach((v) => console.error(`        ${v.rule}: ${v.detail}`));
    process.exit(1);
  }

  // Belt and braces on the shape itself: only the four projected keys may exist.
  const allowedKeys = ['id', 'answer', 'area', 'asks'];
  for (const fact of accepted) {
    const extra = Object.keys(fact).filter((k) => !allowedKeys.includes(k));
    if (extra.length > 0) {
      console.error(`[facts] FATAL: fact "${fact.id}" carries unprojected key(s): ${extra.join(', ')}`);
      process.exit(1);
    }
  }

  write(outFile, accepted);
  console.log(`[facts] ${accepted.length} fact(s) from ${files.length} file(s) -> ${outFile}`);
}

function write(outFile: string, facts: ServedFact[]): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(facts, null, 2) + '\n', 'utf8');
}

function report(rejected: Rejection[]): void {
  console.error(`\n[facts] ${rejected.length} fact(s) rejected. Nothing was written.\n`);
  for (const { file, violations } of rejected) {
    console.error(`  ${file}`);
    for (const v of violations) {
      console.error(`    ${v.rule.padEnd(32)} ${v.detail}`);
    }
    console.error('');
  }
  console.error('Fix the source files. The gate never sanitises, on purpose:');
  console.error('silently repairing leaky output teaches the generator that it is acceptable.\n');
}

main();
