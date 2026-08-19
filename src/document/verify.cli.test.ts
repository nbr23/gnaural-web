import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScheduleWithWarnings } from './parser';
import { serializeSchedule } from './serializer';
import { entryWarnings, scheduleWarnings } from './warnings';

/**
 * Validates `.gnaural` files that are not in the repo, against the code that will import them:
 * `GNAURAL_VERIFY=/path/a.gnaural,/path/b.gnaural npx vitest run src/document/verify.cli.test.ts`
 */
const paths = (process.env.GNAURAL_VERIFY ?? '')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);

describe.skipIf(paths.length === 0)('GNAURAL_VERIFY', () => {
  for (const path of paths) {
    describe(path, () => {
      const xml = readFileSync(path, 'utf8');

      it('parses, and the app has no warning about it', () => {
        const { schedule, warnings } = parseScheduleWithWarnings(xml);
        const all = [...warnings, ...scheduleWarnings(schedule), ...entryWarnings(schedule)];

        for (const warning of all) {
          console.log(`  ${warning.severity}: [${warning.kind}] ${warning.message}`);
        }

        expect(all.filter((warning) => warning.severity === 'warning')).toEqual([]);
      });

      it('survives a round trip through the app unchanged', () => {
        const first = serializeSchedule(parseScheduleWithWarnings(xml).schedule);
        const second = serializeSchedule(parseScheduleWithWarnings(first).schedule);
        expect(second).toBe(first);
      });
    });
  }
});
