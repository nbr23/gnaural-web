import { describe, expect, it } from 'vitest';
import { scheduleDuration } from '../document/timing';
import { PROGRAMS, findProgram, loadProgram, programsByCategory, programsIn } from './programs';

describe('bundled library', () => {
  it('lists all 43 programs with unique ids', () => {
    expect(PROGRAMS).toHaveLength(43);
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(43);
  });

  it('holds three collections, Gnaural’s own, the Android app’s and the Brain Machine’s', () => {
    // fixtures/gnaural/README.md: 21 presets published by the Gnaural project itself, against the
    // Android app's 17 conversions and the two Gnaural files it redistributed after editing them.
    // fixtures/brainmachine/README.md: the three brainwave tables of Mitch Altman's kit.
    expect(programsIn('gnaural')).toHaveLength(21);
    expect(programsIn('android')).toHaveLength(19);
    expect(programsIn('brainmachine')).toHaveLength(3);
  });

  it('preserves every author credit — attribution is owed regardless of the licence question', () => {
    // fixtures/presets/README.md: 9 Android presets credit @GiorgioRegni, 7 credit @thegreenman,
    // and exactly one is uncredited upstream. Every one of Gnaural's own 21 carries an <author>,
    // so a second blank here would mean a credit got dropped.
    const uncredited = PROGRAMS.filter((program) => program.author.trim() === '');
    expect(uncredited.map((program) => program.id)).toEqual(['sleep-smr']);
  });

  it('titles the two files both collections contain by the collection they came from', () => {
    // The Android app shipped edited copies of Gnaural's Power Nap and travel aid, and both copies
    // are kept. Untitled apart they would be two identical-looking rows.
    const duplicated = PROGRAMS.filter((program) => program.title.startsWith('Power Nap'));
    expect(duplicated.map((program) => program.title)).toEqual([
      'Power Nap (Gnaural)',
      'Power Nap (Android)',
    ]);
    expect(new Set(PROGRAMS.map((program) => program.title)).size).toBe(PROGRAMS.length);
  });

  it('groups by category, Gnaural’s own collection first', () => {
    const categories = programsByCategory();
    expect(categories.map((c) => c.label).slice(0, 3)).toEqual(['Gnaural', 'Contrib', 'Sleep']);
    expect(categories.map((c) => c.label)).toContain('Out of body experience');
    expect(categories.flatMap((c) => c.programs)).toHaveLength(43);
  });

  it('files the two redistributed Gnaural files under Sleep, where the app itself had them', () => {
    // `SLEEP_POWERNAP` and `SLEEP_AIRPLANETRAVELAID`. A category of their own would repeat what the
    // `(Android)` in the title already says.
    const sleep = programsIn('android').filter((program) => program.category === 'Sleep');
    expect(sleep.map((program) => program.id)).toEqual([
      'powernap',
      'airplanetravelaid',
      'sleep-sleep-induction',
      'sleep-smr',
    ]);
  });

  it('splits Gnaural’s collection by who signed the file', () => {
    // The seven Bret Logan signed "Gnaural" against the fourteen other people contributed. Nothing
    // curated decides this — the <author> field does.
    const own = programsIn('gnaural').filter((program) => program.category === 'Official');
    const contributed = programsIn('gnaural').filter((program) => program.category === 'Contributed');

    expect(own).toHaveLength(7);
    expect(own.every((program) => program.author === 'Gnaural')).toBe(true);
    expect(contributed).toHaveLength(14);
    expect(contributed.some((program) => program.author === 'Gnaural')).toBe(false);
  });

  it('knows exactly which four presets lost their ambient bed', () => {
    // fixtures/presets/README.md: four presets used the ambient ogg loop PLAN.md §4.6 left behind,
    // and it names the app-level noise layer (§4.5b) as their remedy. The player points at that
    // control on these four and nowhere else, so the set is pinned rather than inferred.
    expect(PROGRAMS.filter((program) => program.lostAmbientBed).map((program) => program.id)).toEqual([
      'healing-morphine',
      'meditation-unity',
      'oobe-lucid-dreams-2',
      'sleep-sleep-induction',
    ]);
  });

  it('resolves a program by id and rejects an unknown one', async () => {
    expect(findProgram('powernap')?.title).toBe('Power Nap (Android)');
    expect(findProgram('power-nap')?.title).toBe('Power Nap (Gnaural)');
    expect(findProgram('nope')).toBeUndefined();
    await expect(loadProgram('nope')).rejects.toThrow(/Unknown program/);
  });
});

describe('every bundled program parses', () => {
  // The whole parser corpus, and two very different shapes of file: the Android 17 were machine
  // generated (many short entries, epsilon-length breakpoints, explicit noise voices), while
  // Gnaural's own 21 include zero-length entries, nine voices, ten thousand entries and every voice
  // type but PCM (fixtures/gnaural/README.md).
  it.each(PROGRAMS.map((program) => [program.id, program] as const))('%s', async (_id, program) => {
    const { schedule } = await loadProgram(program.id);

    expect(schedule.voices.length).toBeGreaterThan(0);
    expect(schedule.voices.every((voice) => voice.entries.length > 0)).toBe(true);
    expect(scheduleDuration(schedule)).toBeGreaterThan(0);
    // The manifest's declared duration is metadata, not truth — but it should not be wildly off.
    // Relative, because the corpus spans a one-second loop to 73 minutes and an absolute tolerance
    // cannot describe both.
    expect(scheduleDuration(schedule)).toBeCloseTo(program.durationSeconds, precisionFor(program.durationSeconds));
  });
});

/** Two significant figures, whatever the scale: a one-second loop and a 4410 s programme. */
function precisionFor(seconds: number): number {
  return 1 - Math.ceil(Math.log10(Math.max(seconds, 1e-3)));
}

/**
 * The Brain Machine ports, checked against the `brainwaveTab[]` they came from
 * (`fixtures/brainmachine/README.md`).
 *
 * Not a duplicate of the tables — the seconds each sequence spends in each band, which is four
 * numbers per file and is what a bad merge, a dropped row or a mistyped duration would move. The
 * bands themselves are fixed: one voice, a 100 Hz carrier throughout, and a beat that is only ever
 * one of the sketch's five documented values.
 */
describe('the Brain Machine sequences match their sketches', () => {
  const BANDS = { gamma: 40, beta: 14.4, alpha: 11.1, theta: 6, delta: 2.2 };

  const TABLES: Record<string, Partial<Record<keyof typeof BANDS, number>>> = {
    'brain-machine-meditation': { beta: 238, alpha: 355, theta: 260, delta: 3 },
    'brain-machine-sleep': { beta: 111, alpha: 260, theta: 1390, delta: 15 },
    'brain-machine-gamma': { gamma: 3600, beta: 8, delta: 4 },
  };

  it.each(Object.entries(TABLES))('%s', async (id, table) => {
    const { schedule } = await loadProgram(id);
    const [voice, ...rest] = schedule.voices;
    expect(rest).toHaveLength(0);

    const spent = new Map<number, number>();
    for (const entry of voice.entries) {
      expect(entry.baseFreq).toBe(100);
      expect(Object.values(BANDS)).toContain(entry.beatFreq);
      spent.set(entry.beatFreq, (spent.get(entry.beatFreq) ?? 0) + entry.duration);
    }

    for (const [band, seconds] of Object.entries(table)) {
      // Each block carries a 1 ms pin at its own value, so a band runs one millisecond long per
      // block it occupies — at most 18 of them here, well inside this tolerance.
      expect(spent.get(BANDS[band as keyof typeof BANDS])).toBeCloseTo(seconds, 1);
    }
    expect(spent.size).toBe(Object.keys(table).length);
  });
});
