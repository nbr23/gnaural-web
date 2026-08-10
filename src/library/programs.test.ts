import { describe, expect, it } from 'vitest';
import { scheduleDuration } from '../document/timing';
import { PROGRAMS, findProgram, loadProgram, programsByCategory } from './programs';

describe('bundled library', () => {
  it('lists all 19 programs with unique ids', () => {
    expect(PROGRAMS).toHaveLength(19);
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(19);
  });

  it('preserves every author credit — attribution is owed regardless of the licence question', () => {
    // fixtures/presets/README.md: 9 presets credit @GiorgioRegni, 7 credit @thegreenman, and
    // exactly one is uncredited upstream. A second blank here would mean a credit got dropped.
    const uncredited = PROGRAMS.filter((program) => program.author.trim() === '');
    expect(uncredited.map((program) => program.id)).toEqual(['sleep-smr']);
  });

  it('groups by category with the Gnaural originals first', () => {
    const categories = programsByCategory();
    expect(categories[0].label).toBe('Gnaural originals');
    expect(categories.map((c) => c.label)).toContain('OOBE');
    expect(categories.flatMap((c) => c.programs)).toHaveLength(19);
  });

  it('resolves a program by id and rejects an unknown one', async () => {
    expect(findProgram('powernap')?.title).toBe('Power Nap');
    expect(findProgram('nope')).toBeUndefined();
    await expect(loadProgram('nope')).rejects.toThrow(/Unknown program/);
  });
});

describe('every bundled program parses', () => {
  // A wider parser corpus than the two files the document tests cover: these 17 were machine
  // generated to a different shape than Gnaural's own output (many short entries, epsilon-length
  // breakpoints, explicit noise voices).
  it.each(PROGRAMS.map((program) => [program.id, program] as const))('%s', async (_id, program) => {
    const schedule = await loadProgram(program.id);

    expect(schedule.voices.length).toBeGreaterThan(0);
    expect(schedule.voices.every((voice) => voice.entries.length > 0)).toBe(true);
    expect(scheduleDuration(schedule)).toBeGreaterThan(0);
    // The manifest's declared duration is metadata, not truth — but it should not be wildly off.
    expect(scheduleDuration(schedule)).toBeCloseTo(program.durationSeconds, -1);
  });
});
