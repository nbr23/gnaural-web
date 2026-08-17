import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures');

export function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

/**
 * How long a sweep over the whole corpus may take.
 *
 * Vitest's 5 s default was ample for 19 short files and is not for 55: `hypnagogic-gale` alone is
 * 10,080 entries, and happy-dom's `DOMParser` is an order of magnitude slower than a browser's.
 * Parsing every bundled program is a second or two of real work, which is the price of a corpus
 * wide enough to be worth asserting over.
 */
export const CORPUS_TIMEOUT = 30_000;

/** Every bundled `.gnaural` file, for anything that should hold across the whole corpus. */
export function fixtureNames(): string[] {
  return [
    'powernap.gnaural',
    'airplanetravelaid.gnaural',
    ...namesIn('presets'),
    ...namesIn('gnaural'),
  ];
}

/** One collection's files, for what holds of Gnaural's own output but not of Android's. */
export function namesIn(directory: 'presets' | 'gnaural'): string[] {
  return readdirSync(path.join(FIXTURES_DIR, directory))
    .filter((name) => name.endsWith('.gnaural'))
    .map((name) => `${directory}/${name}`);
}
