/**
 * End-to-end tests for the fact build.
 *
 * These run the script as a subprocess rather than importing it, because the
 * behaviour that matters is the exit code and whether an artefact was written.
 * A gate that logs a violation and still writes the file is not a gate, and only
 * a process-level test can catch that regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = new URL('../scripts/build-facts.ts', import.meta.url).pathname;

function run(inDir: string, outFile: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, '--in', inDir, '--out', outFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'facts-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

const GOOD = `---
id: fee-parent-lc-scope
area: fees
asks: who can set fees for a local centre
verified_in_app: true
citation: UserFeePriceController.php:88
---

A parent local centre admin can set fees for the centres beneath them.
`;

const LEAKY = `---
id: guard-check
area: fees
asks: how is access checked
---

Access is checked in UserFeePriceController with ADMIN_PARENT_LOCAL.
`;

test('builds a clean fact and strips the citation', () => {
  const dir = fixture({ 'good.md': GOOD });
  const out = join(dir, 'facts.serve.json');

  const { code } = run(dir, out);
  assert.equal(code, 0);

  const raw = readFileSync(out, 'utf8');
  assert.ok(!raw.includes('citation'), 'citation key survived projection');
  assert.ok(!raw.includes('Controller'), 'citation value survived projection');

  const facts = JSON.parse(raw);
  assert.equal(facts.length, 1);
  assert.deepEqual(Object.keys(facts[0]).sort(), ['answer', 'area', 'asks', 'id']);

  rmSync(dir, { recursive: true, force: true });
});

test('a leaky fact fails the build and writes nothing', () => {
  const dir = fixture({ 'good.md': GOOD, 'leaky.md': LEAKY });
  const out = join(dir, 'facts.serve.json');

  const { code, output } = run(dir, out);
  assert.equal(code, 1, 'build must fail');
  assert.ok(!existsSync(out), 'no artefact may be written when any fact is rejected');
  assert.match(output, /identifier\.class/);
  assert.match(output, /identifier\.permission-constant/);

  rmSync(dir, { recursive: true, force: true });
});

test('a missing fact directory yields an empty index, not an error', () => {
  // The index legitimately starts empty: facts are promoted from real
  // escalations rather than authored up front.
  const dir = mkdtempSync(join(tmpdir(), 'facts-'));
  const out = join(dir, 'facts.serve.json');

  const { code } = run(join(dir, 'nope'), out);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), []);

  rmSync(dir, { recursive: true, force: true });
});
