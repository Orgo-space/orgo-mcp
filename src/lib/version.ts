/**
 * The release version, read from package.json at runtime.
 *
 * Hardcoded strings drifted: every release up to 0.1.7 told clients it was
 * 0.1.0. package.json ships next to dist/ in the npm package and in both
 * images, so this resolves the same way everywhere.
 */

import { createRequire } from 'node:module';

export const VERSION: string = createRequire(import.meta.url)('../../package.json').version;
