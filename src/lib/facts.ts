/**
 * Behaviour facts: parsing, and the projection that separates what a human
 * reviews from what a server is allowed to hold.
 *
 * A fact is one markdown file so that review happens in a merge-request diff,
 * in prose, by a person. Frontmatter carries flat scalars; the body is the
 * answer an administrator would be given.
 *
 *   ---
 *   id: fee-parent-lc-scope
 *   area: fees
 *   asks: who can set fees for a local centre
 *   verified_in_app: true
 *   citation: UserFeePriceController.php:88
 *   ---
 *
 *   A parent local centre admin can set fees for the centres beneath them.
 *   A local centre admin can only set their own.
 *
 * The `citation` field never reaches the served artefact. See `toServed`.
 */

export interface FactSource {
  id: string;
  area: string;
  /** The question shape this answers. Indexed for retrieval alongside the answer. */
  asks: string;
  /** True only when a human has observed the behaviour in the running app. */
  verifiedInApp: boolean;
  /** Where the claim came from. Stays in the repository. Never served. */
  citation?: string;
  answer: string;
  /** Source path, for error messages. */
  file: string;
}

/**
 * What the public server is allowed to hold. Three fields, deliberately.
 *
 * The support MCP cannot disclose a citation under any prompt, because the
 * process never receives one. That is a structural property, not a policy.
 */
export interface ServedFact {
  id: string;
  answer: string;
  area: string;
  /** Retrieval needs the question shape; it is derived from the answer's own topic. */
  asks: string;
}

export class FactParseError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'FactParseError';
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const REQUIRED = ['id', 'area', 'asks'] as const;

/**
 * Parse one fact file.
 *
 * Deliberately hand-rolled rather than pulling a YAML dependency: the schema is
 * flat scalars only, and a full YAML parser would accept structures this format
 * has no meaning for (anchors, nested maps, multi-document files).
 */
export function parseFact(text: string, file: string): FactSource {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new FactParseError(file, 'missing or malformed frontmatter block');
  }

  const [, head, body] = match;
  const fields = new Map<string, string>();

  head.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      throw new FactParseError(file, `frontmatter line ${i + 1} is not "key: value": ${JSON.stringify(trimmed)}`);
    }

    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (fields.has(key)) {
      throw new FactParseError(file, `duplicate frontmatter key "${key}"`);
    }
    fields.set(key, value);
  });

  for (const key of REQUIRED) {
    if (!fields.get(key)) {
      throw new FactParseError(file, `missing required field "${key}"`);
    }
  }

  const answer = body.trim();
  if (!answer) {
    throw new FactParseError(file, 'body is empty; the body is the answer');
  }

  return {
    id: fields.get('id')!,
    area: fields.get('area')!,
    asks: fields.get('asks')!,
    verifiedInApp: fields.get('verified_in_app') === 'true',
    citation: fields.get('citation'),
    answer,
    file,
  };
}

/**
 * Project a reviewed fact down to what may be served.
 *
 * Written as an explicit field list rather than a destructured rest, so that a
 * field added to `FactSource` later cannot leak into the served artefact by
 * default. New fields must be opted in here, on purpose.
 */
export function toServed(fact: FactSource): ServedFact {
  return {
    id: fact.id,
    answer: fact.answer,
    area: fact.area,
    asks: fact.asks,
  };
}
