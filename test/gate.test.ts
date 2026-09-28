/**
 * Tests for the deterministic output gate.
 *
 * Two failure modes matter and they pull against each other:
 *
 *   - a leak that passes  → the security property is gone
 *   - prose that is rejected → reviewers start overriding the gate, and a control
 *                              people routinely override is not a control
 *
 * So the false-positive cases below are load-bearing, not padding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateAnswer, gateMeta } from '../src/lib/gate.js';
import { parseFact, toServed, FactParseError } from '../src/lib/facts.js';

const rules = (text: string) => gateAnswer(text).violations.map((v) => v.rule);

test('accepts ordinary admin prose', () => {
  const answers = [
    'A parent local centre admin can set fees for the centres beneath them. A local centre admin can only set their own.',
    'Family members are linked from Profile, then Update Profile, then the Family tab.',
    'Turning the module off hides it for everyone in the organisation, including existing members.',
    'Members keep their history when they resign; the record is retained but marked inactive.',
  ];
  for (const a of answers) {
    assert.deepEqual(gateAnswer(a).violations, [], `should accept: ${a}`);
  }
});

test('accepts product nouns that look like class names', () => {
  // LocalCenter, EventApp and Orgo are real words in a real answer. Matching
  // bare PascalCase would reject all three, which is why the rule matches suffixes.
  const a = 'The Event App shows a member their upcoming events. Each Local Centre has its own organiser.';
  assert.deepEqual(gateAnswer(a).violations, []);
});

test('accepts prose that previously tripped path rules', () => {
  assert.deepEqual(rules('The API/REST integration is described in the developer docs.'), []);
  assert.deepEqual(rules('The mobile client runs on Node.js under the hood.'), []);
});

test('rejects code syntax', () => {
  assert.ok(rules('Call $user->getLocalCenter() to resolve it.').includes('syntax.arrow'));
  assert.ok(rules('Use Tenant::resolve for this.').includes('syntax.scope-resolution'));
  assert.ok(rules('The handler is (x) => x.id').includes('syntax.fat-arrow'));
  assert.ok(rules('It returns { id: 1 }').includes('syntax.braces'));
  assert.ok(rules('SELECT * FROM user WHERE id = 1').includes('syntax.sql'));
  assert.ok(rules('Render <UserCard /> in the view.').includes('syntax.tag'));
  assert.ok(rules('The value of $tenantId is set on persist.').includes('syntax.php-var'));
});

test('rejects repository paths and file names', () => {
  assert.ok(rules('See api/src/Entity/User.php for the field list.').includes('path.repo'));
  assert.ok(rules('It lives in the User.php file.').includes('path.extension'));
  assert.ok(rules('Defined under App\\Entity namespace.').includes('path.namespace'));
});

test('rejects class names by suffix', () => {
  assert.ok(rules('This is enforced in UserFeePriceController.').includes('identifier.class'));
  assert.ok(rules('The MergeService handles it.').includes('identifier.class'));
  assert.ok(rules('CustomVoter decides access.').includes('identifier.class'));
});

test('rejects permission constants but allows capability language', () => {
  // Decision 14: describe what an admin can do, never the mechanism.
  assert.ok(rules('Requires ADMIN_PARENT_LOCAL on the centre.').includes('identifier.permission-constant'));
  assert.deepEqual(rules('A parent local centre admin can do this; a local centre admin cannot.'), []);
});

test('rejects environment variable names', () => {
  assert.ok(rules('Set ORGO_TENANT_HOST to your domain.').includes('identifier.env-var'));
});

test('rejects credential shapes', () => {
  assert.ok(rules('Use sk-ant-api03-AbCdEfGhIjKl to authenticate.').includes('secret.anthropic'));
  assert.ok(rules('The key is sk_live_51HxYzAbCdEfGhIj here.').includes('secret.stripe'));
  assert.ok(rules('Webhook secret whsec_AbCdEfGhIjKlMnOp is set.').includes('secret.stripe-webhook'));
  assert.ok(rules('Token AKIAIOSFODNN7EXAMPLE is stored.').includes('secret.aws-key'));
  assert.ok(rules('-----BEGIN RSA PRIVATE KEY-----').includes('secret.private-key'));
});

test('enforces the word cap', () => {
  const long = Array.from({ length: 61 }, () => 'word').join(' ');
  assert.ok(rules(long).includes('length.max-words'));
  assert.deepEqual(gateAnswer(long, { maxWords: 100 }).violations, []);
});

test('rejects an empty answer', () => {
  assert.ok(rules('   ').includes('length.empty'));
});

test('reports every violation, not just the first', () => {
  const found = rules('See api/src/Entity/User.php and call $user->getId() with ADMIN_LOCAL.');
  assert.ok(found.length >= 3, `expected several violations, got ${JSON.stringify(found)}`);
});

test('metadata rules', () => {
  const ok = { id: 'fee-parent-lc-scope', area: 'fees', verifiedInApp: false };
  assert.deepEqual(gateMeta(ok).violations, []);

  const bad = gateMeta({ id: 'Fee_Parent Scope', area: 'billing', verifiedInApp: false }).violations.map((v) => v.rule);
  assert.ok(bad.includes('meta.id-format'));
  assert.ok(bad.includes('meta.unknown-area'));
});

test('permission facts must be verified in the app', () => {
  const unverified = gateMeta({ id: 'who-edits-profiles', area: 'permissions', verifiedInApp: false });
  assert.ok(unverified.violations.some((v) => v.rule === 'meta.permissions-unverified'));

  const verified = gateMeta({ id: 'who-edits-profiles', area: 'permissions', verifiedInApp: true });
  assert.deepEqual(verified.violations, []);
});

const FACT = `---
id: fee-parent-lc-scope
area: fees
asks: who can set fees for a local centre
verified_in_app: true
citation: UserFeePriceController.php:88
---

A parent local centre admin can set fees for the centres beneath them.
`;

test('parses a fact file', () => {
  const fact = parseFact(FACT, 'fee-parent-lc-scope.md');
  assert.equal(fact.id, 'fee-parent-lc-scope');
  assert.equal(fact.area, 'fees');
  assert.equal(fact.verifiedInApp, true);
  assert.equal(fact.citation, 'UserFeePriceController.php:88');
  assert.match(fact.answer, /^A parent local centre admin/);
});

test('projection drops the citation', () => {
  const served = toServed(parseFact(FACT, 'x.md'));
  assert.deepEqual(Object.keys(served).sort(), ['answer', 'area', 'asks', 'id']);
  assert.ok(!JSON.stringify(served).includes('Controller'));
  assert.ok(!JSON.stringify(served).includes('citation'));
});

test('rejects malformed fact files', () => {
  assert.throws(() => parseFact('no frontmatter here', 'a.md'), FactParseError);
  assert.throws(() => parseFact('---\narea: fees\nasks: x\n---\n\nbody', 'b.md'), /missing required field "id"/);
  assert.throws(() => parseFact('---\nid: a\narea: fees\nasks: x\n---\n\n   ', 'c.md'), /body is empty/);
  assert.throws(() => parseFact('---\nid: a\nid: b\narea: fees\nasks: x\n---\n\nbody', 'd.md'), /duplicate/);
});
