import { describe, expect, it } from 'vitest';
import { scheduleDuration } from '../document/timing';
import { PROGRAMS, findProgram, loadProgram, programsByCategory, programsIn } from './programs';

describe('bundled library', () => {
  it('lists all 40 programs with unique ids', () => {
    expect(PROGRAMS).toHaveLength(40);
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(40);
  });

  it('holds two collections, Gnaural’s own and the Android app’s', () => {
    // fixtures/gnaural/README.md: 21 presets published by the Gnaural project itself, against the
    // Android app's 17 conversions and the two Gnaural files it redistributed after editing them.
    expect(programsIn('gnaural')).toHaveLength(21);
    expect(programsIn('android')).toHaveLength(19);
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
    expect(categories.map((c) => c.label).slice(0, 3)).toEqual([
      'Gnaural',
      'Contrib',
      'Gnaural edits',
    ]);
    expect(categories.map((c) => c.label)).toContain('OOBE');
    expect(categories.flatMap((c) => c.programs)).toHaveLength(40);
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
