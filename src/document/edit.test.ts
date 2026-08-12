import { describe, expect, it } from 'vitest';
import { moveEntry, updateEntry, updateSchedule } from './edit';
import { parseSchedule } from './parser';
import { serializeSchedule } from './serializer';
import { loadFixture } from './test-fixtures';
import { entryStartTimes, voiceDuration } from './timing';
import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';

/** A real multi-voice document, so the structural-sharing assertions have something to share. */
function fixture() {
  return parseSchedule(loadFixture('presets/oobe-lucid-dreams-2.gnaural'));
}

/** Durations 10/20/30, so every clamp below lands on a number that can be read at a glance. */
function ramp(durations: number[]): Schedule {
  const entries = durations.map<Entry>((duration, index) => ({
    duration,
    baseFreq: 200 - index * 10,
    beatFreq: 10 - index,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
  }));
  const voice: Voice = {
    id: 0,
    description: 'Carrier',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
  };
  return {
    title: 'Ramp',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice, { ...voice, id: 1, description: 'Second' }],
    preserved: {},
  };
}

function starts(schedule: Schedule, voice = 0): number[] {
  return entryStartTimes(schedule.voices[voice]);
}

describe('updateSchedule', () => {
  it('applies the patch and leaves everything else alone', () => {
    const before = fixture();
    const after = updateSchedule(before, { title: 'Draft of lucid dreams', loops: 0 });

    expect(after.title).toBe('Draft of lucid dreams');
    expect(after.loops).toBe(0);
    expect(after.author).toBe(before.author);
    expect(after.description).toBe(before.description);
    expect(after.stereoSwap).toBe(before.stereoSwap);
  });

  it('never mutates its input', () => {
    const before = fixture();
    const title = before.title;
    updateSchedule(before, { title: 'something else' });
    expect(before.title).toBe(title);
  });

  /**
   * The premise the history stack's memory budget rests on. If a transform is ever rewritten with a
   * deep clone, a 200-step history goes from a few hundred kilobytes to tens of megabytes, and
   * nothing else in the suite would notice.
   */
  it('keeps the identity of everything it did not touch', () => {
    const before = fixture();
    const after = updateSchedule(before, { title: 'renamed' });

    expect(after).not.toBe(before);
    expect(after.voices).toBe(before.voices);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[0].entries).toBe(before.voices[0].entries);
    expect(after.preserved).toBe(before.preserved);
  });

  /** So retyping a title that is already there does not push an undo step. */
  it('returns the same object when the patch changes nothing', () => {
    const before = fixture();

    expect(updateSchedule(before, {})).toBe(before);
    expect(updateSchedule(before, { title: before.title })).toBe(before);
    expect(updateSchedule(before, { masterVolume: { ...before.masterVolume } })).toBe(before);
  });

  it('compares master volume by value, since it is an object', () => {
    const before = fixture();
    const louder = { left: before.masterVolume.left / 2, right: before.masterVolume.right };
    const after = updateSchedule(before, { masterVolume: louder });

    expect(after).not.toBe(before);
    expect(after.masterVolume).toEqual(louder);
  });

  /** §3.4: unrecognised data survives a round-trip, including one that goes through the editor. */
  it('leaves preserved data intact through a serialize', () => {
    const before = fixture();
    const after = updateSchedule(before, { author: 'Someone else' });
    const reparsed = parseSchedule(serializeSchedule(after));

    expect(reparsed.author).toBe('Someone else');
    expect(reparsed.voices[0].preserved).toEqual(before.voices[0].preserved);
    expect(reparsed.voices[0].entries[0].preserved).toEqual(before.voices[0].entries[0].preserved);
  });
});

describe('updateEntry', () => {
  it('patches one entry and leaves the rest of the document alone', () => {
    const before = ramp([10, 20, 30]);
    const after = updateEntry(before, 0, 1, { beatFreq: 6.5, baseFreq: 300 });

    expect(after.voices[0].entries[1].beatFreq).toBe(6.5);
    expect(after.voices[0].entries[1].baseFreq).toBe(300);
    expect(after.voices[0].entries[1].volumeLeft).toBe(0.5);
    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([10, 20, 30]);
  });

  it('keeps the identity of every voice and entry it did not touch', () => {
    const before = fixture();
    const after = updateEntry(before, 1, 3, { beatFreq: 9 });

    expect(after).not.toBe(before);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
    expect(after.voices[1]).not.toBe(before.voices[1]);
    expect(after.voices[1].entries[2]).toBe(before.voices[1].entries[2]);
    expect(after.voices[1].entries[4]).toBe(before.voices[1].entries[4]);
    expect(after.voices[1].entries[3].preserved).toBe(before.voices[1].entries[3].preserved);
  });

  it('returns the same object when nothing changes, so no undo step is pushed', () => {
    const before = ramp([10, 20, 30]);
    const entry = before.voices[0].entries[1];

    expect(updateEntry(before, 0, 1, {})).toBe(before);
    expect(updateEntry(before, 0, 1, { beatFreq: entry.beatFreq })).toBe(before);
    expect(updateEntry(before, 0, 99, { beatFreq: 1 })).toBe(before);
    expect(updateEntry(before, 9, 0, { beatFreq: 1 })).toBe(before);
  });

  it('changes the voice length when the patch is a duration', () => {
    const before = ramp([10, 20, 30]);
    const after = updateEntry(before, 0, 1, { duration: 50 });

    expect(voiceDuration(after.voices[0])).toBe(90);
    expect(starts(after)).toEqual([0, 10, 60]);
  });
});

describe('moveEntry', () => {
  it('squeezes by default: the neighbours hold still and the voice keeps its length', () => {
    const before = ramp([10, 20, 30]);
    const after = moveEntry(before, { voice: 0, entry: 1, time: 25, mode: 'squeeze' });

    expect(starts(after)).toEqual([0, 25, 30]);
    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([25, 5, 30]);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
  });

  it('ripples on the modifier: everything after it moves and the voice grows', () => {
    const before = ramp([10, 20, 30]);
    const after = moveEntry(before, { voice: 0, entry: 1, time: 25, mode: 'ripple' });

    expect(starts(after)).toEqual([0, 25, 45]);
    expect(voiceDuration(after.voices[0])).toBe(75);
  });

  /**
   * §3.7 in the small: a drag is not allowed to invent a negative duration, and the presets' 0.001 s
   * entries make reaching a neighbour the common case rather than an edge one.
   */
  it('clamps at zero duration in both directions rather than passing a neighbour', () => {
    const before = ramp([10, 20, 30]);

    const back = moveEntry(before, { voice: 0, entry: 1, time: -100, mode: 'squeeze' });
    expect(starts(back)).toEqual([0, 0, 30]);
    expect(back.voices[0].entries[0].duration).toBe(0);

    const forward = moveEntry(before, { voice: 0, entry: 1, time: 100, mode: 'squeeze' });
    expect(starts(forward)).toEqual([0, 30, 30]);
    expect(forward.voices[0].entries[1].duration).toBe(0);

    const rippledBack = moveEntry(before, { voice: 0, entry: 2, time: -5, mode: 'ripple' });
    expect(starts(rippledBack)).toEqual([0, 10, 10]);
  });

  /** Ripple has no upper bound: nothing follows the last entry to be squeezed. */
  it('ripples the last entry whatever the mode says', () => {
    const before = ramp([10, 20, 30]);
    const squeezed = moveEntry(before, { voice: 0, entry: 2, time: 100, mode: 'squeeze' });

    expect(starts(squeezed)).toEqual([0, 10, 100]);
    expect(voiceDuration(squeezed.voices[0])).toBe(130);
    expect(squeezed.voices[0].entries[2].duration).toBe(30);
  });

  it('refuses to move entry 0, whose start is zero by definition', () => {
    const before = ramp([10, 20, 30]);
    expect(moveEntry(before, { voice: 0, entry: 0, time: 5, mode: 'ripple' })).toBe(before);
    expect(moveEntry(before, { voice: 0, entry: 0, time: 0, mode: 'squeeze' })).toBe(before);
  });

  it('returns the same object for a move to where the entry already is', () => {
    const before = ramp([10, 20, 30]);
    expect(moveEntry(before, { voice: 0, entry: 1, time: 10, mode: 'squeeze' })).toBe(before);
    expect(moveEntry(before, { voice: 0, entry: 9, time: 1, mode: 'squeeze' })).toBe(before);
    expect(moveEntry(before, { voice: 5, entry: 1, time: 1, mode: 'squeeze' })).toBe(before);
  });

  it('keeps the identity of the entries and voices it did not touch', () => {
    const before = fixture();
    const after = moveEntry(before, { voice: 2, entry: 5, time: 400, mode: 'squeeze' });

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[1]).toBe(before.voices[1]);
    expect(after.voices[2].entries[0]).toBe(before.voices[2].entries[0]);
    expect(after.voices[2].entries[6]).toBe(before.voices[2].entries[6]);
    expect(after.voices[2].entries[4]).not.toBe(before.voices[2].entries[4]);
  });

  /** A drag has to survive the serializer, or the draft it autosaves is not what was dragged. */
  it('round-trips through the serializer with preserved data intact', () => {
    const before = fixture();
    const target = entryStartTimes(before.voices[0])[2] + 5;
    const after = moveEntry(before, { voice: 0, entry: 3, time: target, mode: 'ripple' });
    const reparsed = parseSchedule(serializeSchedule(after));

    expect(entryStartTimes(reparsed.voices[0])[3]).toBeCloseTo(target, 3);
    expect(reparsed.voices[0].entries[0].preserved).toEqual(before.voices[0].entries[0].preserved);
  });
});
