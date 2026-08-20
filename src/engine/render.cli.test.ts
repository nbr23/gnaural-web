import { readFileSync, writeFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseScheduleWithWarnings } from '../document/parser';
import { DEFAULT_EXPORT_SAMPLE_RATE, renderSchedule } from './render';
import { encodeWav } from './wav';

const input = process.env.GNAURAL_RENDER ?? '';
const output = process.env.GNAURAL_RENDER_OUT ?? '';
const sampleRate = Number(process.env.GNAURAL_RENDER_RATE) || DEFAULT_EXPORT_SAMPLE_RATE;

describe.skipIf(!input || !output)('GNAURAL_RENDER', () => {
  beforeAll(() => {
    globalThis.OfflineAudioContext =
      OfflineAudioContext as unknown as typeof globalThis.OfflineAudioContext;
  });

  it('renders the program to a WAV', async () => {
    const { schedule, warnings } = parseScheduleWithWarnings(readFileSync(input, 'utf8'));
    for (const warning of warnings) {
      console.log(`  ${warning.severity}: [${warning.kind}] ${warning.message}`);
    }

    const buffer = await renderSchedule(schedule, { sampleRate });
    const bytes = Buffer.from(await encodeWav(buffer).arrayBuffer());
    writeFileSync(output, bytes);

    console.log(
      `  ${output}: ${buffer.duration.toFixed(1)}s at ${sampleRate} Hz, ${bytes.length} bytes`,
    );
    expect(buffer.duration).toBeGreaterThan(0);
  }, 600_000);
});
