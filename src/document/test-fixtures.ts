import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures');

export function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}
