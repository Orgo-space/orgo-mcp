/**
 * Deterministic output gate for support answers.
 *
 * This is the load-bearing security control of the support MCP. It runs in two
 * places with identical rules:
 *
 *   1. at build time, over every fact before it can reach `facts.serve.json`
 *   2. at request time, over analyzer output before it can reach Fin
 *
 * It contains no model and makes no judgement calls, which is the entire point:
 * a prompt-injected model can be talked out of a rule, a regex cannot. Anything
 * requiring taste ("is this too revealing?") is deliberately NOT handled here —
 * that is the job of the adversarial judge downstream, which fails closed.
 *
 * Fails closed: an answer that trips any rule is rejected, never sanitised.
 * Silent repair would teach the generator that leaky output is acceptable as
 * long as something scrubs it later.
 */

export type Area = 'users' | 'groups' | 'events' | 'fees' | 'newsletter' | 'permissions' | 'files' | 'organisation';

export const AREAS: readonly Area[] = [
  'users',
  'groups',
  'events',
  'fees',
  'newsletter',
  'permissions',
  'files',
  'organisation',
];

export interface Violation {
  /** Stable rule id, so a rejection message can point at a fix. */
  rule: string;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  violations: Violation[];
}

export interface GateOptions {
  /** Hard cap on answer length. A short answer cannot carry much. */
  maxWords?: number;
}

const DEFAULT_MAX_WORDS = 60;

/**
 * Code-shaped syntax. Presence, not density: none of these belong in a sentence
 * written for an organisation administrator, so a single occurrence is enough.
 */
const SYNTAX: ReadonlyArray<[string, RegExp]> = [
  ['syntax.arrow', /->/],
  ['syntax.scope-resolution', /::/],
  ['syntax.fat-arrow', /=>/],
  ['syntax.braces', /[{}]/],
  ['syntax.keyword', /\b(function|class|return|foreach|const|null|true|false)\s*[({[]/i],
  ['syntax.sql', /\b(SELECT|INSERT|UPDATE|DELETE|JOIN)\s+[A-Za-z*]/],
  ['syntax.tag', /<\/?[a-z][a-z0-9-]*[\s/>]/i],
  ['syntax.php-var', /\$[a-zA-Z_]\w*/],
  ['syntax.annotation', /#\[[A-Z]/],
];

/**
 * Repository paths and source file extensions.
 *
 * Both rules are deliberately narrow. An earlier version matched
 * `(api|client|src)/[a-z]` and rejected the phrase "API/REST", and matched a
 * `.js` extension which rejects "Node.js". A gate that fails closed must not
 * fire on ordinary prose, or reviewers start overriding it out of habit and the
 * control stops meaning anything.
 */
const PATHS: ReadonlyArray<[string, RegExp]> = [
  ['path.repo', /\b(?:api|client)\/src\/|\bsrc\/[A-Za-z]+\/|\b(?:tests?|migrations)\/[A-Za-z]+[./]/],
  ['path.extension', /\.(php|vue|twig|sql|env|mjs|tsx|yaml|yml)\b/i],
  ['path.namespace', /\bApp\\[A-Z]/],
];

/**
 * Class names, matched by their suffix rather than by PascalCase.
 *
 * Matching bare PascalCase would reject legitimate product nouns — LocalCenter,
 * EventApp and Orgo all appear in perfectly good answers. Suffix matching is
 * precise: an administrator never needs to hear the word "Controller".
 */
const CODE_SUFFIXES =
  'Controller|Service|Repository|Voter|Subscriber|Listener|Normalizer|Provider|Handler|Factory|Extension|Filter|Resolver|Transformer|Validator|Entity|Manager';
const IDENTIFIERS: ReadonlyArray<[string, RegExp]> = [
  ['identifier.class', new RegExp(`\\b[A-Z][A-Za-z0-9]*(?:${CODE_SUFFIXES})\\b`)],
  // Permission constants. Decision 14: capability language only, never the
  // mechanism. "A parent local centre admin can…" is fine, ADMIN_PARENT_LOCAL is not.
  ['identifier.permission-constant', /\b(ADMIN|HR|FINANCIAL)_(TENANT|LOCAL|PARENT_LOCAL)\b/],
  ['identifier.env-var', /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/],
];

/** Credential shapes. Belt and braces: nothing should ever produce these. */
const SECRETS: ReadonlyArray<[string, RegExp]> = [
  ['secret.anthropic', /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ['secret.openai', /\bsk-[A-Za-z0-9]{20,}/],
  ['secret.stripe', /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/],
  ['secret.stripe-webhook', /\bwhsec_[A-Za-z0-9]{10,}/],
  ['secret.github', /\b(ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['secret.aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['secret.jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['secret.private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const ALL_RULES = [...SYNTAX, ...PATHS, ...IDENTIFIERS, ...SECRETS];

/**
 * Run every rule against an answer. Returns all violations rather than the first,
 * so a human fixing a rejected fact sees the whole problem in one pass.
 */
export function gateAnswer(answer: string, opts: GateOptions = {}): GateResult {
  const violations: Violation[] = [];
  const text = answer.trim();

  if (text.length === 0) {
    violations.push({ rule: 'length.empty', detail: 'answer is empty' });
  }

  const maxWords = opts.maxWords ?? DEFAULT_MAX_WORDS;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > maxWords) {
    violations.push({ rule: 'length.max-words', detail: `${words} words, limit is ${maxWords}` });
  }

  for (const [rule, pattern] of ALL_RULES) {
    const match = pattern.exec(text);
    if (match) {
      violations.push({ rule, detail: `matched ${JSON.stringify(match[0])}` });
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface FactMeta {
  id: string;
  area: string;
  verifiedInApp: boolean;
}

/**
 * Rules that apply to a fact's metadata rather than its prose.
 *
 * The permissions rule encodes decision 14: permission behaviour is where a
 * fact derived from reading the code is most likely to describe the intent and
 * miss the behaviour. Those facts are only trustworthy once someone has
 * observed them in the app.
 */
export function gateMeta(meta: FactMeta): GateResult {
  const violations: Violation[] = [];

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.id)) {
    violations.push({ rule: 'meta.id-format', detail: `"${meta.id}" is not kebab-case` });
  }

  if (!(AREAS as readonly string[]).includes(meta.area)) {
    violations.push({
      rule: 'meta.unknown-area',
      detail: `"${meta.area}" is not one of: ${AREAS.join(', ')}`,
    });
  }

  if (meta.area === 'permissions' && !meta.verifiedInApp) {
    violations.push({
      rule: 'meta.permissions-unverified',
      detail: 'area "permissions" requires verified_in_app: true (observe it in the app, do not trust the generated claim)',
    });
  }

  return { ok: violations.length === 0, violations };
}
