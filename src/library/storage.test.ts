import { beforeEach, describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import { resetDatabase } from '../test-setup';
import {
  getImported,
  importProgram,
  listImported,
  loadSettings,
  removeImported,
  saveSetting,
} from './storage';

const POWERNAP = loadFixture('powernap.gnaural');
const AIRPLANE = loadFixture('airplanetravelaid.gnaural');

function importFixture(name: string, text: string) {
  return importProgram(name, text, parseSchedule(text));
}

beforeEach(resetDatabase);

describe('imported programs', () => {
  it('stores a program with metadata derived from the schedule', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);

    expect(program.title).toBe('Power Nap');
    expect(program.author).toBe('Gnaural');
    expect(program.sourceName).toBe('powernap.gnaural');
    // The shortest voice (§3.7), which for this single-voice file is the whole thing.
    expect(program.durationSeconds).toBeCloseTo(1200, 5);
    expect(await getImported(program.id)).toEqual(program);
  });

  it('keeps the original text rather than re-serialized XML', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);

    expect(program.text).toBe(POWERNAP);
  });

  it('lists the most recently imported first', async () => {
    const first = await importFixture('powernap.gnaural', POWERNAP);
    const second = await importFixture('airplanetravelaid.gnaural', AIRPLANE);

    expect((await listImported()).map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it('returns the existing entry when the same text is imported again', async () => {
    const first = await importFixture('powernap.gnaural', POWERNAP);
    const again = await importFixture('a-different-name.gnaural', POWERNAP);

    expect(again.id).toBe(first.id);
    expect(again.sourceName).toBe('powernap.gnaural');
    expect(await listImported()).toHaveLength(1);
  });

  it('removes a program', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);
    await removeImported(program.id);

    expect(await listImported()).toHaveLength(0);
    expect(await getImported(program.id)).toBeUndefined();
  });

  it('falls back to the filename when a schedule has no title', async () => {
    const untitled = POWERNAP.replace('<title>Power Nap</title>', '<title></title>');
    const program = await importFixture('mystery.gnaural', untitled);

    expect(program.title).toBe('mystery.gnaural');
  });
});

describe('settings', () => {
  it('starts empty so callers fall back to their own defaults', async () => {
    expect(await loadSettings()).toEqual({});
  });

  it('round-trips every setting it is given', async () => {
    await saveSetting('masterGain', 0.4);
    await saveSetting('exportSampleRate', 22050);
    await saveSetting('wakeLock', true);

    expect(await loadSettings()).toEqual({
      masterGain: 0.4,
      exportSampleRate: 22050,
      wakeLock: true,
    });
  });

  it('overwrites a setting rather than accumulating values', async () => {
    await saveSetting('masterGain', 0.4);
    await saveSetting('masterGain', 0.9);

    expect(await loadSettings()).toEqual({ masterGain: 0.9 });
  });
});
