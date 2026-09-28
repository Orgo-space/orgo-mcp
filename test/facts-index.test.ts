/**
 * Retrieval tests.
 *
 * The behaviour under test that matters most is the negative one: an unrelated
 * question must return nothing, because an empty result is what makes Fin hand
 * off to a human instead of answering from the least-irrelevant fact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactsIndex, MAX_RESULTS, tokenize } from '../src/lib/facts-index.js';
import type { ServedFact } from '../src/lib/facts.js';

const facts: ServedFact[] = [
  {
    id: 'fee-parent-lc-scope',
    area: 'fees',
    asks: 'who can set fees for a local centre',
    answer: 'A parent local centre admin can set fees for the centres beneath them. A local centre admin can only set their own.',
  },
  {
    id: 'fee-under-18',
    area: 'fees',
    asks: 'different fee for members under 18',
    answer: 'Age-based fees are set per membership year, so a member under 18 is charged the price attached to their age band.',
  },
  {
    id: 'newsletter-local-group',
    area: 'newsletter',
    asks: 'send a newsletter to one local group only',
    answer: 'Pick the local group as the audience when composing. Members outside it are excluded even if subscribed.',
  },
  {
    id: 'resign-history',
    area: 'users',
    asks: 'what happens to member data on resignation',
    answer: 'The record is retained and marked inactive. History and past payments stay visible to administrators.',
  },
];

const index = new FactsIndex(facts);

test('tokenizer drops stopwords and single characters', () => {
  assert.deepEqual(tokenize('How do I set a fee?'), ['set', 'fee']);
});

test('finds the relevant fact', () => {
  const hits = index.search('who sets fees for a local centre');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].fact.id, 'fee-parent-lc-scope');
});

test('returns nothing for an unrelated question', () => {
  // The load-bearing case: silence routes the conversation to a human.
  assert.deepEqual(index.search('how do I export invoices to my accountant'), []);
  assert.deepEqual(index.search('reset the printer'), []);
});

test('returns nothing for a query of only stopwords', () => {
  assert.deepEqual(index.search('how do I'), []);
});

test('one shared term is not enough to be relevant', () => {
  // "member" appears in several facts, but a question about member photos is
  // about none of them. Partial term overlap must not produce an answer.
  assert.deepEqual(index.search('can a member upload a profile photo avatar'), []);
});

test('area filter narrows the pool', () => {
  const all = index.search('local');
  const scoped = index.search('local', 'newsletter');
  assert.ok(all.length >= scoped.length);
  assert.ok(scoped.every((h) => h.fact.area === 'newsletter'));
});

test('never returns more than the cap', () => {
  const many = new FactsIndex(
    Array.from({ length: 20 }, (_, i) => ({
      id: `fee-${i}`,
      area: 'fees',
      asks: 'fee question about fees',
      answer: 'A fee answer about fees and fees.',
    })),
  );
  assert.equal(many.search('fee').length, MAX_RESULTS);
});

test('a match in asks outranks the same term in an answer', () => {
  const pair = new FactsIndex([
    { id: 'in-answer', area: 'users', asks: 'unrelated topic entirely', answer: 'Resignation is handled automatically.' },
    { id: 'in-asks', area: 'users', asks: 'resignation process for members', answer: 'Some other prose here.' },
  ]);
  const hits = pair.search('resignation');
  assert.equal(hits[0].fact.id, 'in-asks');
});

test('an empty index returns nothing rather than throwing', () => {
  assert.deepEqual(new FactsIndex([]).search('anything at all'), []);
});
