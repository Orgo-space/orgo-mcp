/**
 * In-memory retrieval over behaviour facts.
 *
 * BM25 rather than embeddings, deliberately: the corpus is a few hundred short
 * entries, so lexical scoring is accurate enough, costs no network call, adds no
 * vendor, and returns in well under a millisecond. Fin's tool budget is a few
 * seconds end to end; spending any of it on an embedding round-trip buys nothing
 * at this scale.
 *
 * Two properties matter as much as relevance:
 *
 *   - **No enumeration.** Search only. There is no list-all, no get-by-id and no
 *     cursor, so the index can be sampled but never systematically dumped. This
 *     is a security constraint, not an API convenience decision — see
 *     docs/support-agent/STATE.md.
 *   - **Silence beats a bad match.** Below `MIN_SCORE` the index returns nothing,
 *     which makes Fin hand off rather than answer from the least-irrelevant fact.
 */

import type { ServedFact } from './facts.js';

const K1 = 1.2;
const B = 0.75;

/**
 * Relevance is gated on term coverage, not on an absolute BM25 score.
 *
 * An absolute threshold does not survive a small corpus: when a term appears in
 * most documents its idf collapses toward zero, so a perfectly good single-word
 * query scores below any fixed floor and returns nothing. Coverage asks a
 * question that stays meaningful at any corpus size — how much of what they
 * asked does this fact actually address?
 *
 * Requirement is half the query's meaningful terms, capped at three so that a
 * long, chatty question is not over-filtered.
 */
const MIN_COVERAGE = 0.5;
const MAX_REQUIRED_TERMS = 3;

function requiredMatches(termCount: number): number {
  return Math.min(MAX_REQUIRED_TERMS, Math.max(1, Math.ceil(termCount * MIN_COVERAGE)));
}

/** Hard cap on results. No pagination, by design. */
export const MAX_RESULTS = 3;

/**
 * `asks` carries the question shape, so a term matching there is stronger
 * evidence than the same term in the prose answer.
 */
const ASKS_WEIGHT = 2;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'we', 'you', 'they', 'do', 'does', 'did', 'can', 'could',
  'how', 'what', 'when', 'where', 'who', 'why', 'my', 'our', 'your', 'their',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface Doc {
  fact: ServedFact;
  tf: Map<string, number>;
  length: number;
}

export interface SearchHit {
  fact: ServedFact;
  score: number;
}

export class FactsIndex {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private avgLength = 0;

  constructor(facts: ServedFact[]) {
    for (const fact of facts) {
      const tokens = [
        ...tokenize(fact.asks).flatMap((t) => Array<string>(ASKS_WEIGHT).fill(t)),
        ...tokenize(fact.answer),
      ];

      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);

      this.docs.push({ fact, tf, length: tokens.length });
    }

    this.avgLength = this.docs.length
      ? this.docs.reduce((sum, d) => sum + d.length, 0) / this.docs.length
      : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * Rank facts against a query. Returns at most `MAX_RESULTS`, and returns an
   * empty array rather than a weak match — silence is the correct answer when
   * nothing is relevant, because it routes the conversation to a human.
   */
  search(query: string, area?: string): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docs.length === 0) return [];

    const pool = area ? this.docs.filter((d) => d.fact.area === area) : this.docs;
    const needed = requiredMatches(terms.length);
    const hits: SearchHit[] = [];

    for (const doc of pool) {
      let score = 0;
      let matched = 0;

      for (const term of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        matched += 1;

        const df = this.df.get(term) ?? 0;
        // The 1 + … form of idf never goes negative, so a term present in every
        // document contributes nothing rather than subtracting from the score.
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        const norm = tf + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1));

        score += idf * ((tf * (K1 + 1)) / norm);
      }

      // Coverage decides relevance; BM25 only decides order among the relevant.
      if (matched >= needed) hits.push({ fact: doc.fact, score });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  }
}

/**
 * Load a built artefact. Tolerates a missing file: the index legitimately starts
 * empty, since facts are promoted from real escalations rather than authored
 * up front, and an empty index simply means every question escalates.
 */
export function loadFacts(path: string, read: (p: string) => string, exists: (p: string) => boolean): ServedFact[] {
  if (!exists(path)) return [];

  const parsed = JSON.parse(read(path));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of facts`);
  }
  return parsed as ServedFact[];
}
