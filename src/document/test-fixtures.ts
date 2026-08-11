import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures');

export function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

/** Every bundled `.gnaural` file, for anything that should hold across the whole corpus. */
export function fixtureNames(): string[] {
  const presets = readdirSync(path.join(FIXTURES_DIR, 'presets'))
    .filter((name) => name.endsWith('.gnaural'))
    .map((name) => `presets/${name}`);

  return ['powernap.gnaural', 'airplanetravelaid.gnaural', ...presets];
}
