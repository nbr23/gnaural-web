import { describe, expect, it } from 'vitest';
import { compileVoice, eventBaseFreq, eventBeatFreq, valueAtTime } from '../engine/compiler';
import { DEFAULT_LIVE_VALUES } from '../live/liveSchedule';
import {
  NEW_VOICE_SECONDS,
  adjustEntries,
  duplicateVoice,
  insertEntry,
  insertVoice,
  moveEntries,
  moveEntry,
  moveVoice,
  offsetVoice,
  padVoicesToLongest,
  removeEntries,
  removeEntry,
  removeVoice,
  repairVoiceGrouping,
  reverseVoice,
  scaleEntries,
  setScheduleLength,
  updateEntry,
  updateSchedule,
  updateVoice,
} from './edit';
import { parseSchedule } from './parser';
import { serializeSchedule } from './serializer';
import { fixtureNames, loadFixture } from './test-fixtures';
import { entryStartTimes, scheduleDuration, voiceDuration } from './timing';
import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';
import { REMOVED } from './voiceMap';
import { entryWarnings } from './warnings';

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

  /** Â§3.4: unrecognised data survives a round-trip, including one that goes through the editor. */
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
   * Â§3.7 in the small: a drag is not allowed to invent a negative duration, and the presets' 0.001 s
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

describe('updateVoice', () => {
  it('patches one voice and keeps the identity of the rest', () => {
    const before = fixture();
    const after = updateVoice(before, 1, { description: 'Carrier', muted: true });

    expect(after.voices[1].description).toBe('Carrier');
    expect(after.voices[1].muted).toBe(true);
    expect(after.voices[1].entries).toBe(before.voices[1].entries);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
  });

  it('returns the same object when nothing changes', () => {
    const before = fixture();

    expect(updateVoice(before, 0, {})).toBe(before);
    expect(updateVoice(before, 0, { hidden: before.voices[0].hidden })).toBe(before);
    expect(updateVoice(before, 9, { muted: true })).toBe(before);
  });

  /** Step 4 put `hidden` inside the history stack because it is in the file and it serializes. */
  it('writes both document flags through the serializer', () => {
    const before = fixture();
    const after = updateVoice(updateVoice(before, 0, { muted: true }), 0, { hidden: true });
    const reparsed = parseSchedule(serializeSchedule(after));

    expect(reparsed.voices[0].muted).toBe(true);
    expect(reparsed.voices[0].hidden).toBe(true);
  });

  /**
   * `type` joined the patch in step 10, for the isochronic pair: 3 and 4 differ only in which ear
   * each pulse lands in, so switching is a toggle on the voice rather than a new voice. It is also
   * one of the three things `requiresVoiceRebuild` fires on, so it crossfades in the engine.
   */
  it('switches a voice between the two isochronic types, and serializes it', () => {
    const before = updateVoice(fixture(), 0, { type: VoiceType.IsoPulse });
    const after = updateVoice(before, 0, { type: VoiceType.IsoPulseAlt });

    expect(after.voices[0].type).toBe(VoiceType.IsoPulseAlt);
    expect(after.voices[0].entries).toBe(before.voices[0].entries);
    expect(updateVoice(after, 0, { type: VoiceType.IsoPulseAlt })).toBe(after);
    expect(parseSchedule(serializeSchedule(after)).voices[0].type).toBe(VoiceType.IsoPulseAlt);
  });
});

describe('insertEntry', () => {
  it('splits the segment in two without changing the voice length', () => {
    const before = ramp([10, 20, 30]);
    const after = insertEntry(before, { voice: 0, after: 1 });

    expect(starts(after)).toEqual([0, 10, 20, 30]);
    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([10, 10, 10, 30]);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
  });

  it('splits at an explicit time, clamped to the segment it was asked to split', () => {
    const before = ramp([10, 20, 30]);

    expect(starts(insertEntry(before, { voice: 0, after: 1, time: 12 }))).toEqual([0, 10, 12, 30]);
    expect(starts(insertEntry(before, { voice: 0, after: 1, time: -50 }))).toEqual([0, 10, 10, 30]);
    expect(starts(insertEntry(before, { voice: 0, after: 1, time: 999 }))).toEqual([0, 10, 30, 30]);
  });

  /**
   * The property that makes an insert a handle rather than an edit: the curve through the new node
   * is the curve that was already there.
   */
  it('puts the new node exactly on the existing curve', () => {
    const before = fixture();
    const voice = before.voices[0];
    const at = entryStartTimes(voice)[3] + voice.entries[3].duration / 2;
    const inserted = insertEntry(before, { voice: 0, after: 3 }).voices[0].entries[4];

    const onCurve = valueAtTime(compileVoice(voice), at);
    expect(inserted.baseFreq).toBeCloseTo(eventBaseFreq(onCurve), 9);
    expect(inserted.beatFreq).toBeCloseTo(eventBeatFreq(onCurve), 9);
    expect(inserted.volumeLeft).toBeCloseTo(onCurve.leftGain, 9);
    expect(inserted.volumeRight).toBeCloseTo(onCurve.rightGain, 9);
  });

  /**
   * Â§3.5's unconditional wrap *is* the last entry's segment, so splitting it is the ordinary
   * operation rather than a special case â and the value at the split is on the way back to
   * entry[0], not a hold at the last entry's own value.
   */
  it('splits the final segment, where the curve is heading back to entry 0', () => {
    const before = ramp([10, 20, 30]);
    const after = insertEntry(before, { voice: 0, after: 2 });
    const entries = after.voices[0].entries;

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.duration)).toEqual([10, 20, 15, 15]);
    expect(voiceDuration(after.voices[0])).toBe(60);
    // Halfway from entry[2] (180 Hz) back to entry[0] (200 Hz).
    expect(entries[3].baseFreq).toBeCloseTo(190, 9);
  });

  it('splits a one-entry voice, whose single segment is a constant hold', () => {
    const before = ramp([600]);
    const after = insertEntry(before, { voice: 0, after: 0 });

    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([300, 300]);
    expect(after.voices[0].entries[1].baseFreq).toBe(200);
    expect(voiceDuration(after.voices[0])).toBe(600);
  });

  /** An imported file can carry one; Â§3.7 says the repair is the length the rest of it plays to. */
  it('gives an empty voice its first entry rather than splitting nothing', () => {
    const before = ramp([10, 20, 30]);
    const emptied: Schedule = {
      ...before,
      voices: [before.voices[0], { ...before.voices[1], entries: [] }],
    };
    const after = insertEntry(emptied, { voice: 1, after: 0 });

    expect(after.voices[1].entries).toHaveLength(1);
    expect(voiceDuration(after.voices[1])).toBe(60);
  });

  it('keeps the identity of every voice and untouched entry', () => {
    const before = fixture();
    const after = insertEntry(before, { voice: 1, after: 4 });

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
    expect(after.voices[1].entries[0]).toBe(before.voices[1].entries[0]);
    expect(after.voices[1].entries[6]).toBe(before.voices[1].entries[5]);
  });

  it('carries no preserved data, so the serializer writes the owning voice id as the parent', () => {
    const before = fixture();
    const after = insertEntry(before, { voice: 2, after: 0 });
    const xml = serializeSchedule(after);
    const reparsed = parseSchedule(xml);

    expect(after.voices[2].entries[1].preserved).toEqual({});
    expect(reparsed.voices[2].entries[1].preserved.parent).toBe(String(before.voices[2].id));
    expect(reparsed.voices[2].entries).toHaveLength(before.voices[2].entries.length + 1);
  });

  it('returns the same object for a voice that is not there', () => {
    const before = ramp([10, 20, 30]);
    expect(insertEntry(before, { voice: 9, after: 0 })).toBe(before);
  });
});

describe('removeEntry', () => {
  it('gives the removed duration to the entry before it, keeping the voice length', () => {
    const before = ramp([10, 20, 30]);
    const after = removeEntry(before, { voice: 0, entry: 1 });

    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([30, 30]);
    expect(voiceDuration(after.voices[0])).toBe(60);
  });

  it('gives it to the entry after, when the first one goes', () => {
    const before = ramp([10, 20, 30]);
    const after = removeEntry(before, { voice: 0, entry: 0 });

    expect(after.voices[0].entries.map((e) => e.duration)).toEqual([30, 30]);
    expect(after.voices[0].entries[0].baseFreq).toBe(190);
    expect(voiceDuration(after.voices[0])).toBe(60);
  });

  /** The property that makes the pair honest: an insert you did not want costs nothing to take back. */
  it('is the exact inverse of an insert', () => {
    const before = ramp([10, 20, 30]);
    const round = removeEntry(insertEntry(before, { voice: 0, after: 1, time: 17 }), {
      voice: 0,
      entry: 2,
    });

    expect(round.voices[0].entries.map((e) => e.duration)).toEqual([10, 20, 30]);
    expect(round.voices[0].entries[1].baseFreq).toBe(before.voices[0].entries[1].baseFreq);
  });

  /**
   * Refused rather than warned. Gnaural groups entries into voices by the `parent` attribute and
   * takes voice properties by document order, so a voice with no entries does not merely vanish on
   * reopen â every voice after it takes the wrong slot's description, type and flags.
   */
  it('refuses to empty a voice', () => {
    const single = ramp([600]);
    expect(removeEntry(single, { voice: 0, entry: 0 })).toBe(single);
  });

  it('returns the same object for an entry or voice that is not there', () => {
    const before = ramp([10, 20, 30]);
    expect(removeEntry(before, { voice: 0, entry: 9 })).toBe(before);
    expect(removeEntry(before, { voice: 0, entry: -1 })).toBe(before);
    expect(removeEntry(before, { voice: 9, entry: 0 })).toBe(before);
  });

  it('keeps the identity of every voice and untouched entry', () => {
    const before = fixture();
    const after = removeEntry(before, { voice: 1, entry: 4 });

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
    expect(after.voices[1].entries[0]).toBe(before.voices[1].entries[0]);
    expect(after.voices[1].entries[5]).toBe(before.voices[1].entries[6]);
  });
});

describe('insertVoice', () => {
  it('appends a one-entry voice spanning exactly what the schedule already plays', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = insertVoice(before, { kind: 'tone' });
    const added = after.voices[3];

    expect(after.voices).toHaveLength(4);
    expect(added.entries).toHaveLength(1);
    expect(voiceDuration(added)).toBe(scheduleDuration(before));
    expect(scheduleDuration(after)).toBe(scheduleDuration(before));
    expect(voiceMap).toEqual([0, 1, 2]);
  });

  it('takes its tone values from the same defaults Live mode uses', () => {
    const { schedule } = insertVoice(fixture(), { kind: 'tone' });
    const entry = schedule.voices[3].entries[0];

    expect(entry.baseFreq).toBe(DEFAULT_LIVE_VALUES.baseFreq);
    expect(entry.beatFreq).toBe(DEFAULT_LIVE_VALUES.beatFreq);
    // Deliberately not 1.0 â a new voice at full scale on top of a programme already near it clips.
    expect(entry.volumeLeft).toBe(0.5);
    expect(entry.volumeRight).toBe(0.5);
    expect(schedule.voices[3].type).toBe(VoiceType.Binaural);
  });

  /**
   * The one row of defaults with no corpus behind it — no bundled file uses any type 2–6 — so it
   * takes the tone row's numbers rather than inventing a difference that is not there. Pinned
   * against that row, not restated, so the three cannot drift apart.
   */
  it('gives an isochronic voice the same values as a tone voice', () => {
    const { schedule } = insertVoice(fixture(), { kind: 'isochronic' });
    const voice = schedule.voices[3];
    const tone = insertVoice(fixture(), { kind: 'tone' }).schedule.voices[3];

    expect(voice.type).toBe(VoiceType.IsoPulse);
    expect(voice.description).toBe('Isochronic pulse');
    expect(voice.entries[0]).toEqual(tone.entries[0]);
  });

  /** All nine noise voices in the bundled library are exactly this. */
  it('takes its noise values from the corpus convention', () => {
    const { schedule } = insertVoice(fixture(), { kind: 'noise' });
    const voice = schedule.voices[3];

    expect(voice.type).toBe(VoiceType.PinkNoise);
    expect(voice.description).toBe('Background noise');
    expect(voice.entries[0].baseFreq).toBe(100);
    expect(voice.entries[0].beatFreq).toBe(0);
  });

  it('inserts in the middle and reports where everything went', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = insertVoice(before, { kind: 'tone', at: 1 });

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[1]);
    expect(after.voices[3]).toBe(before.voices[2]);
    expect(voiceMap).toEqual([0, 2, 3]);
  });

  it('numbers a new voice past every existing id and renumbers nothing', () => {
    const before = fixture();
    const once = insertVoice(before, { kind: 'tone' }).schedule;
    const twice = insertVoice(once, { kind: 'noise' }).schedule;

    expect(twice.voices.map((voice) => voice.id)).toEqual([0, 1, 2, 3, 4]);
    expect(twice.voices[0].id).toBe(before.voices[0].id);
  });

  it('falls back to a session-length voice when there is nothing to match', () => {
    const empty: Schedule = { ...fixture(), voices: [] };
    const { schedule, voiceMap } = insertVoice(empty, { kind: 'tone' });

    expect(voiceDuration(schedule.voices[0])).toBe(NEW_VOICE_SECONDS);
    expect(schedule.voices[0].id).toBe(0);
    expect(voiceMap).toEqual([]);
  });

  /** Â§6.3: what this editor writes has to reopen in Gnaural desktop, which groups by `parent`. */
  it('round-trips through the serializer with the parent attribute written', () => {
    const { schedule } = insertVoice(fixture(), { kind: 'noise' });
    const reparsed = parseSchedule(serializeSchedule(schedule));
    const added = reparsed.voices[3];

    expect(added.entries[0].preserved.parent).toBe(String(schedule.voices[3].id));
    expect(added.type).toBe(VoiceType.PinkNoise);
    expect(voiceDuration(added)).toBeCloseTo(voiceDuration(schedule.voices[3]), 6);
  });
});

describe('removeVoice', () => {
  it('drops the voice and reports the gap it closed', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = removeVoice(before, 1);

    expect(after.voices).toHaveLength(2);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[1]).toBe(before.voices[2]);
    expect(voiceMap).toEqual([0, REMOVED, 1]);
  });

  /** An accepted state, not a refused one: 9a already warns for it and already disables Play. */
  it('allows the last voice to go', () => {
    const single: Schedule = { ...fixture(), voices: [fixture().voices[0]] };
    const { schedule: after, voiceMap } = removeVoice(single, 0);

    expect(after.voices).toEqual([]);
    expect(scheduleDuration(after)).toBe(0);
    expect(voiceMap).toEqual([REMOVED]);
  });

  it('returns the same object and an identity map for a voice that is not there', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = removeVoice(before, 9);

    expect(after).toBe(before);
    expect(voiceMap).toEqual([0, 1, 2]);
  });
});

describe('moveVoice', () => {
  it('reorders and reuses every voice object, allocating only the array', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = moveVoice(before, { from: 0, to: 2 });

    expect(after.voices).toEqual([before.voices[1], before.voices[2], before.voices[0]]);
    expect(after.voices[0]).toBe(before.voices[1]);
    expect(after.voices[2]).toBe(before.voices[0]);
    expect(voiceMap).toEqual([2, 0, 1]);
  });

  it('moves in both directions', () => {
    const before = fixture();
    const up = moveVoice(before, { from: 2, to: 0 });

    expect(up.schedule.voices[0]).toBe(before.voices[2]);
    expect(up.voiceMap).toEqual([1, 2, 0]);
  });

  it('returns the same object for a move that goes nowhere', () => {
    const before = fixture();

    expect(moveVoice(before, { from: 1, to: 1 }).schedule).toBe(before);
    expect(moveVoice(before, { from: 9, to: 0 }).schedule).toBe(before);
    // Clamped rather than refused, so a button at the end of the list is a no-op not a crash.
    expect(moveVoice(before, { from: 2, to: 5 }).schedule).toBe(before);
  });

  it('changes nothing audible about the document except the order', () => {
    const before = fixture();
    const { schedule: after } = moveVoice(before, { from: 0, to: 1 });

    expect(scheduleDuration(after)).toBe(scheduleDuration(before));
    expect(parseSchedule(serializeSchedule(after)).voices.map((v) => v.description)).toEqual([
      before.voices[1].description,
      before.voices[0].description,
      before.voices[2].description,
    ]);
  });
});

/**
 * Â§6.1's "move a selection as a group" â the block rule, and the reason it is a block.
 *
 * The run from the lowest selected entry to the highest travels together, unselected entries
 * included: moving only the selected ones would let a node pass a neighbour nobody asked about,
 * which reorders the voice.
 */
describe('moveEntries', () => {
  it('moves the block and holds the voice’s length under a squeeze', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = moveEntries(before, {
      nodes: [
        { voice: 0, entry: 1 },
        { voice: 0, entry: 2 },
      ],
      deltaTime: 5,
      mode: 'squeeze',
    });

    expect(starts(after)).toEqual([0, 15, 35, 60]);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
  });

  it('carries the unselected nodes inside the run along, so nothing changes order', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = moveEntries(before, {
      nodes: [
        { voice: 0, entry: 1 },
        { voice: 0, entry: 3 },
      ],
      deltaTime: 5,
      mode: 'squeeze',
    });

    // Entry 2 was never selected and still moved: it sits inside the run.
    expect(starts(after)).toEqual([0, 15, 35, 65]);
  });

  /** Â§3.7: a ripple changes how long the program plays, and squeeze is the default for that reason. */
  it('lengthens the voice under a ripple, since nothing gives the time back', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = moveEntries(before, {
      nodes: [{ voice: 0, entry: 1 }],
      deltaTime: 5,
      mode: 'ripple',
    });

    expect(starts(after)).toEqual([0, 15, 35, 65]);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]) + 5);
  });

  /** One shift for every voice: a group move must not silently desynchronise two of them. */
  it('clamps to the tightest voice and applies that one shift everywhere', () => {
    const before = ramp([10, 20, 30, 40]);
    before.voices[1] = { ...before.voices[1], entries: [
      { ...before.voices[1].entries[0], duration: 2 },
      ...before.voices[1].entries.slice(1),
    ] };

    const after = moveEntries(before, {
      nodes: [
        { voice: 0, entry: 1 },
        { voice: 1, entry: 1 },
      ],
      deltaTime: -8,
      mode: 'squeeze',
    });

    // Voice 1 can only give up 2 s, so both voices move by 2 s and stay aligned.
    expect(starts(after, 0)).toEqual([0, 8, 30, 60]);
    expect(starts(after, 1)[1]).toBe(0);
  });

  /** Entry 0's start is the sum of no durations, so a block that reaches it starts at entry 1. */
  it('never moves a first node, and a selection of only first nodes moves nothing', () => {
    const before = ramp([10, 20, 30]);
    const withFirst = moveEntries(before, {
      nodes: [
        { voice: 0, entry: 0 },
        { voice: 0, entry: 1 },
      ],
      deltaTime: 5,
      mode: 'squeeze',
    });
    // Entry 0 is pinned, so the run begins at entry 1 and entry 0's own duration absorbs the shift.
    expect(starts(withFirst)).toEqual([0, 15, 30]);

    expect(
      moveEntries(before, { nodes: [{ voice: 0, entry: 0 }], deltaTime: 5, mode: 'squeeze' }),
    ).toBe(before);
  });

  it('clamps at the neighbour rather than letting a block pass it', () => {
    const before = ramp([10, 20, 30]);
    const after = moveEntries(before, {
      nodes: [{ voice: 0, entry: 1 }],
      deltaTime: 1000,
      mode: 'squeeze',
    });

    expect(starts(after)).toEqual([0, 30, 30]);
    expect(after.voices[0].entries[1].duration).toBe(0);
  });

  it('returns its input for a selection that changes nothing', () => {
    const before = ramp([10, 20, 30]);
    expect(moveEntries(before, { nodes: [], deltaTime: 5, mode: 'squeeze' })).toBe(before);
    expect(
      moveEntries(before, { nodes: [{ voice: 0, entry: 1 }], deltaTime: 0, mode: 'squeeze' }),
    ).toBe(before);
  });

  it('reuses every voice and entry it did not touch', () => {
    const before = fixture();
    const after = moveEntries(before, {
      nodes: [{ voice: 0, entry: 2 }],
      deltaTime: 1,
      mode: 'squeeze',
    });

    expect(after).not.toBe(before);
    expect(after.voices[1]).toBe(before.voices[1]);
    expect(after.voices[0].entries[5]).toBe(before.voices[0].entries[5]);
  });
});

/** Â§6.1's "scale a selection as a group", which is not Â§6.1's whole-program duration scaling. */
describe('scaleEntries', () => {
  const selection = [
    { voice: 0, entry: 1 },
    { voice: 0, entry: 3 },
  ];

  it('stretches the time inside the selection about its own start', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = scaleEntries(before, { nodes: selection, factor: 2, mode: 'ripple' });

    // The block spans 10..60; doubled it spans 10..110, and its first node has not moved.
    expect(starts(after)).toEqual([0, 10, 50, 110]);
  });

  /**
   * A block ending on the voice's last entry has no following segment, so it necessarily ripples —
   * the same rule a single-node drag has obeyed since step 5. These two need a node after the block
   * for the squeeze to have anywhere to put the time.
   */
  it('gives the difference back to the following segment under a squeeze', () => {
    const before = ramp([10, 20, 30, 40, 50]);
    const after = scaleEntries(before, { nodes: selection, factor: 1.5, mode: 'squeeze' });

    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
    expect(starts(after)).toEqual([0, 10, 40, 85, 100]);
  });

  it('compresses on a factor below one', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = scaleEntries(before, { nodes: selection, factor: 0.5, mode: 'ripple' });

    expect(starts(after)).toEqual([0, 10, 20, 35]);
  });

  it('stops at the neighbour rather than pushing a squeeze past it', () => {
    const before = ramp([10, 20, 30, 40, 50]);
    const after = scaleEntries(before, { nodes: selection, factor: 100, mode: 'squeeze' });

    expect(after.voices[0].entries[3].duration).toBe(0);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
  });

  it('needs a span, so one node in a voice scales nothing', () => {
    const before = ramp([10, 20, 30]);
    expect(scaleEntries(before, { nodes: [{ voice: 0, entry: 1 }], factor: 2, mode: 'ripple' })).toBe(
      before,
    );
  });

  it('refuses a factor that is not a positive number', () => {
    const before = ramp([10, 20, 30]);
    expect(scaleEntries(before, { nodes: selection, factor: 0, mode: 'ripple' })).toBe(before);
    expect(scaleEntries(before, { nodes: selection, factor: -1, mode: 'ripple' })).toBe(before);
    expect(scaleEntries(before, { nodes: selection, factor: 1, mode: 'ripple' })).toBe(before);
  });
});

/** The group value drag: one delta on every node, so the shape of the selection survives. */
describe('adjustEntries', () => {
  it('shifts every selected node by the same amount', () => {
    const before = ramp([10, 20, 30]);
    const after = adjustEntries(before, {
      nodes: [
        { voice: 0, entry: 0 },
        { voice: 1, entry: 2 },
      ],
      field: 'beatFreq',
      delta: 2,
    });

    expect(after.voices[0].entries[0].beatFreq).toBe(12);
    expect(after.voices[1].entries[2].beatFreq).toBe(10);
    // Untouched nodes keep their identity, which is what the history budget rests on.
    expect(after.voices[0].entries[1]).toBe(before.voices[0].entries[1]);
  });

  it('clamps to the bounds it is given, so a drag cannot author what it cannot draw', () => {
    const before = ramp([10, 20, 30]);
    const after = adjustEntries(before, {
      nodes: [{ voice: 0, entry: 0 }],
      field: 'volumeLeft',
      delta: 5,
      min: 0,
      max: 1,
    });

    expect(after.voices[0].entries[0].volumeLeft).toBe(1);
  });

  it('returns its input for a delta of zero', () => {
    const before = ramp([10, 20, 30]);
    expect(
      adjustEntries(before, { nodes: [{ voice: 0, entry: 0 }], field: 'baseFreq', delta: 0 }),
    ).toBe(before);
  });
});

/**
 * A group delete folds `removeEntry`, so it inherits step 6's absorb rule and its hard floor: a
 * voice contributing no entry does not vanish on reopen in Gnaural, it takes every later voice's
 * identity with it (`SG_RestoreBackupData`, ScheduleGUI.c:2213).
 */
describe('removeEntries', () => {
  it('removes every selected node and preserves each voice’s length', () => {
    const before = ramp([10, 20, 30, 40]);
    const after = removeEntries(before, [
      { voice: 0, entry: 1 },
      { voice: 0, entry: 2 },
    ]);

    expect(after.voices[0].entries).toHaveLength(2);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
  });

  it('leaves one node standing rather than emptying a voice', () => {
    const before = ramp([10, 20, 30]);
    const after = removeEntries(before, [
      { voice: 0, entry: 0 },
      { voice: 0, entry: 1 },
      { voice: 0, entry: 2 },
    ]);

    expect(after.voices[0].entries).toHaveLength(1);
    expect(voiceDuration(after.voices[0])).toBe(60);
  });

  it('spans voices, and touches no voice it was not asked about', () => {
    const before = ramp([10, 20, 30]);
    const after = removeEntries(before, [
      { voice: 0, entry: 1 },
      { voice: 1, entry: 2 },
    ]);

    expect(after.voices[0].entries).toHaveLength(2);
    expect(after.voices[1].entries).toHaveLength(2);
  });

  it('returns its input for an empty selection', () => {
    const before = ramp([10, 20, 30]);
    expect(removeEntries(before, [])).toBe(before);
  });
});

describe('duplicateVoice', () => {
  it('copies the voice next to its source and reports where everything went', () => {
    const before = fixture();
    const { schedule: after, voiceMap } = duplicateVoice(before, 0);

    expect(after.voices).toHaveLength(4);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[1]);
    expect(after.voices[1].entries).toHaveLength(before.voices[0].entries.length);
    expect(voiceDuration(after.voices[1])).toBe(voiceDuration(before.voices[0]));
    expect(voiceMap).toEqual([0, 2, 3]);
  });

  it('keeps the type, the flags and the description, and says it is a copy', () => {
    const before = fixture();
    const source: Voice = { ...before.voices[1], muted: true, mono: true, hidden: true };
    const { schedule } = duplicateVoice({ ...before, voices: [source] }, 0);
    const copy = schedule.voices[1];

    expect(copy.type).toBe(source.type);
    expect([copy.muted, copy.mono, copy.hidden]).toEqual([true, true, true]);
    expect(copy.description).toBe(`${source.description} copy`);
  });

  /**
   * The one line this command turns on. `entryParent` prefers `preserved.parent`, and every corpus
   * entry carries one — so a copy that kept them would sit next to its source claiming the same
   * owner, which is exactly the *merge* shape step 7's `gnaural-regroup` warns about. This is the
   * command authoring the bug the same step repairs, and the strip is what prevents it.
   */
  it('drops the copied entries’ owner, so the copy does not merge back into its source', () => {
    const before = fixture();
    expect(before.voices[0].entries[0].preserved.parent).toBeDefined();

    const { schedule } = duplicateVoice(before, 0);
    const copy = schedule.voices[1];

    expect(copy.entries.every((entry) => !('parent' in entry.preserved))).toBe(true);
    expect(copy.id).toBe(3);
    expect(entryWarnings(schedule).filter((warning) => warning.kind === 'gnaural-regroup')).toEqual([]);
  });

  it('would have merged without the strip — stated so the strip cannot be quietly removed', () => {
    const before = fixture();
    const source = before.voices[0];
    const naive: Voice = { ...source, id: 3, description: 'copy' };
    const merged = { ...before, voices: [source, naive, ...before.voices.slice(1)] };

    expect(entryWarnings(merged).some((warning) => warning.kind === 'gnaural-regroup')).toBe(true);
  });

  it('survives a round trip through the serializer as two separate voices', () => {
    const { schedule } = duplicateVoice(fixture(), 0);
    const reparsed = parseSchedule(serializeSchedule(schedule));

    expect(reparsed.voices).toHaveLength(4);
    expect(reparsed.voices[1].entries[0].preserved.parent).toBe(String(schedule.voices[1].id));
    expect(reparsed.voices[0].entries[0].preserved.parent).not.toBe(
      reparsed.voices[1].entries[0].preserved.parent,
    );
  });

  it('returns its input and an identity map for a voice that is not there', () => {
    const before = fixture();
    const { schedule, voiceMap } = duplicateVoice(before, 9);

    expect(schedule).toBe(before);
    expect(voiceMap).toEqual([0, 1, 2]);
  });
});

describe('reverseVoice', () => {
  /**
   * §3.5 makes a voice a closed curve, so reversing what is *heard* is `r(t) = v(T − t)`: entry 0
   * keeps its values, the rest mirror, and the durations reverse wholesale. `SG_ReverseVoice`
   * (ScheduleGUI.c:4286) does the same thing in pixel space — it leaves the first datapoint alone.
   */
  it('is the curve played backwards, sampled against the compiled original', () => {
    const before = fixture();
    const after = reverseVoice(before, 0);
    const original = compileVoice(before.voices[0]);
    const reversed = compileVoice(after.voices[0]);
    const total = voiceDuration(before.voices[0]);

    for (let step = 0; step <= 20; step += 1) {
      const t = (total * step) / 20;
      expect(eventBeatFreq(valueAtTime(reversed, t))).toBeCloseTo(
        eventBeatFreq(valueAtTime(original, total - t)),
        6,
      );
      expect(eventBaseFreq(valueAtTime(reversed, t))).toBeCloseTo(
        eventBaseFreq(valueAtTime(original, total - t)),
        6,
      );
    }
  });

  it('keeps the voice’s length, its node count and its opening values', () => {
    const before = ramp([10, 20, 30]);
    const after = reverseVoice(before, 0);

    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(before.voices[0]));
    expect(after.voices[0].entries.map((entry) => entry.duration)).toEqual([30, 20, 10]);
    expect(after.voices[0].entries[0].baseFreq).toBe(before.voices[0].entries[0].baseFreq);
    expect(after.voices[0].entries[1].baseFreq).toBe(before.voices[0].entries[2].baseFreq);
  });

  it('is its own inverse', () => {
    const before = fixture();
    const twice = reverseVoice(reverseVoice(before, 1), 1);

    expect(twice.voices[1].entries).toEqual(before.voices[1].entries);
  });

  it('touches no other voice, and returns its input where there is nothing to reverse', () => {
    const before = fixture();
    const after = reverseVoice(before, 1);

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
    expect(reverseVoice(before, 9)).toBe(before);

    // One entry is a constant hold, and two entries of equal length are already their own mirror —
    // both are genuinely nothing to undo.
    const single = ramp([10]);
    const symmetric = ramp([20, 20]);
    expect(reverseVoice(single, 0)).toBe(single);
    expect(reverseVoice(symmetric, 0)).toBe(symmetric);
  });
});

describe('offsetVoice', () => {
  /**
   * The format has no per-voice start, so an offset is a rotation of §3.5's closed curve: the value
   * at `T − s` becomes the value at 0 and everything follows round. Length is preserved, which is
   * what keeps §3.7's spread intact.
   */
  it('rotates the curve, so what is heard at t is what was heard at t − s', () => {
    const before = fixture();
    const shift = 300;
    const after = offsetVoice(before, { voice: 0, seconds: shift });
    const original = compileVoice(before.voices[0]);
    const rotated = compileVoice(after.voices[0]);
    const total = voiceDuration(before.voices[0]);

    expect(voiceDuration(after.voices[0])).toBeCloseTo(total, 6);
    for (let step = 0; step <= 20; step += 1) {
      const t = (total * step) / 20;
      const source = (((t - shift) % total) + total) % total;
      expect(eventBeatFreq(valueAtTime(rotated, t))).toBeCloseTo(
        eventBeatFreq(valueAtTime(original, source)),
        4,
      );
    }
  });

  it('rotates without adding a node when it lands on a breakpoint', () => {
    const before = ramp([10, 20, 30]);
    const after = offsetVoice(before, { voice: 0, seconds: -10 });

    expect(after.voices[0].entries).toHaveLength(3);
    expect(after.voices[0].entries.map((entry) => entry.duration)).toEqual([20, 30, 10]);
    expect(after.voices[0].entries[0]).toBe(before.voices[0].entries[1]);
  });

  it('splits the segment it lands inside, adding exactly one node', () => {
    const before = ramp([10, 20, 30]);
    const after = offsetVoice(before, { voice: 0, seconds: -15 });

    expect(after.voices[0].entries).toHaveLength(4);
    expect(voiceDuration(after.voices[0])).toBeCloseTo(60, 9);
    expect(after.voices[0].entries[0].duration).toBe(15);
  });

  it('comes back to the same curve when offset the other way', () => {
    const before = fixture();
    const there = offsetVoice(before, { voice: 2, seconds: 137 });
    const back = offsetVoice(there, { voice: 2, seconds: -137 });
    const original = compileVoice(before.voices[2]);
    const returned = compileVoice(back.voices[2]);
    const total = voiceDuration(before.voices[2]);

    for (let step = 0; step <= 20; step += 1) {
      const t = (total * step) / 20;
      expect(eventBeatFreq(valueAtTime(returned, t))).toBeCloseTo(
        eventBeatFreq(valueAtTime(original, t)),
        4,
      );
    }
  });

  it('wraps an offset longer than the voice, and returns its input for a whole number of turns', () => {
    const before = ramp([10, 20, 30]);
    const once = offsetVoice(before, { voice: 0, seconds: 10 });
    const twice = offsetVoice(before, { voice: 0, seconds: 70 });

    expect(twice.voices[0].entries).toEqual(once.voices[0].entries);
    expect(offsetVoice(before, { voice: 0, seconds: 60 })).toBe(before);
    expect(offsetVoice(before, { voice: 0, seconds: 0 })).toBe(before);
  });

  it('touches no other voice and refuses what it cannot rotate', () => {
    const before = fixture();
    const after = offsetVoice(before, { voice: 1, seconds: 45 });

    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[2]).toBe(before.voices[2]);
    expect(offsetVoice(before, { voice: 9, seconds: 45 })).toBe(before);
    expect(offsetVoice(before, { voice: 0, seconds: Number.NaN })).toBe(before);
  });
});

describe('padVoicesToLongest', () => {
  /** §3.7's one-click fix. Gnaural pads the same way — `SG_TruncateSchedule` lengthens the last DP. */
  it('adds the shortfall to each short voice’s last entry, and only there', () => {
    const before = ripple(ramp([10, 20, 30]), 1, -12);
    const after = padVoicesToLongest(before);

    expect(voiceDuration(after.voices[1])).toBeCloseTo(60, 9);
    expect(after.voices[1].entries.map((entry) => entry.duration)).toEqual([10, 20, 30]);
    expect(after.voices[1].entries[0]).toBe(before.voices[1].entries[0]);
    expect(after.voices[0]).toBe(before.voices[0]);
  });

  it('leaves the schedule playing its longest voice’s length', () => {
    const before = ripple(ramp([10, 20, 30]), 1, -12);
    const after = padVoicesToLongest(before);

    expect(scheduleDuration(after)).toBeCloseTo(longest(after), 9);
    expect(scheduleDuration(before)).toBeLessThan(longest(before));
  });

  it('returns its input for a schedule that is already even — which is all 19 bundled files', () => {
    for (const name of fixtureNames()) {
      const schedule = parseSchedule(loadFixture(name));
      expect(padVoicesToLongest(schedule)).toBe(schedule);
    }
  });

  /** There is no segment to stretch, and the repair for that voice is a node or a deletion. */
  it('skips a voice with no entries', () => {
    const before = fixture();
    const empty: Voice = { ...before.voices[0], entries: [] };
    const after = padVoicesToLongest({ ...before, voices: [empty, before.voices[1]] });

    expect(after.voices[0].entries).toEqual([]);
  });
});

describe('setScheduleLength', () => {
  it('takes the whole programme to the target, proportionally', () => {
    const before = fixture();
    const after = setScheduleLength(before, 600);

    expect(scheduleDuration(after)).toBeCloseTo(600, 6);
    const factor = 600 / scheduleDuration(before);
    expect(after.voices[0].entries[3].duration).toBeCloseTo(
      before.voices[0].entries[3].duration * factor,
      6,
    );
  });

  /** One factor for every voice, so a ragged schedule stays exactly as ragged in proportion. */
  it('scales every voice by the same factor', () => {
    const before = ripple(ramp([10, 20, 30]), 1, 30);
    const after = setScheduleLength(before, 120);
    const ratio = voiceDuration(before.voices[1]) / voiceDuration(before.voices[0]);

    expect(voiceDuration(after.voices[1]) / voiceDuration(after.voices[0])).toBeCloseTo(ratio, 9);
    expect(scheduleDuration(after)).toBeCloseTo(120, 9);
  });

  it('refuses a target that is not a length, and a schedule with no length', () => {
    const before = ramp([10, 20, 30]);

    expect(setScheduleLength(before, 0)).toBe(before);
    expect(setScheduleLength(before, -60)).toBe(before);
    expect(setScheduleLength(before, Number.NaN)).toBe(before);
    expect(setScheduleLength(before, 60)).toBe(before);
    expect(setScheduleLength({ ...before, voices: [] }, 60)).toStrictEqual({ ...before, voices: [] });
  });
});

describe('repairVoiceGrouping', () => {
  /**
   * Gnaural rebuilds its voices from the entries' `parent` alone (`SG_RestoreBackupData`,
   * ScheduleGUI.c:2213), so these are the two shapes that reopen as something else — and the repair
   * has to clear the warning step 7 raises for them.
   */
  it('separates two adjacent voices whose entries claim the same owner', () => {
    const before = merged();
    expect(entryWarnings(before).some((warning) => warning.kind === 'gnaural-regroup')).toBe(true);

    const after = repairVoiceGrouping(before);

    expect(entryWarnings(after).filter((warning) => warning.kind === 'gnaural-regroup')).toEqual([]);
    expect(after.voices.map((voice) => voice.id)).toEqual([0, 1]);
  });

  it('gives a voice carrying two owners a single one', () => {
    const before = split();
    expect(entryWarnings(before).some((warning) => warning.kind === 'gnaural-regroup')).toBe(true);

    const after = repairVoiceGrouping(before);

    expect(entryWarnings(after).filter((warning) => warning.kind === 'gnaural-regroup')).toEqual([]);
    expect(new Set(after.voices[0].entries.map((entry) => entry.preserved.parent))).toEqual(
      new Set([undefined]),
    );
  });

  it('changes no value, only who owns what', () => {
    const before = merged();
    const after = repairVoiceGrouping(before);

    expect(after.voices.map((voice) => voice.entries.map((entry) => entry.duration))).toEqual(
      before.voices.map((voice) => voice.entries.map((entry) => entry.duration)),
    );
    expect(scheduleDuration(after)).toBe(scheduleDuration(before));
  });

  it('is idempotent', () => {
    const once = repairVoiceGrouping(merged());
    expect(repairVoiceGrouping(once)).toBe(once);
  });

  /** All 51 corpus voices carry `parent == id`, so this is a no-op across the whole library. */
  it('returns its input for every bundled file', () => {
    for (const name of fixtureNames()) {
      const schedule = parseSchedule(loadFixture(name));
      expect(repairVoiceGrouping(schedule)).toBe(schedule);
    }
  });

  /**
   * The third shape it cannot help with: a voice with no entries contributes no datapoint whatever
   * its id, so it disappears on reopen regardless. The warning stays, and the caller offers no
   * button — which is what `=== schedule` is being used to decide.
   */
  it('does nothing for a schedule whose only fault is an empty voice', () => {
    const before = fixture();
    const withEmpty = {
      ...before,
      voices: [{ ...before.voices[0], entries: [] }, before.voices[1]],
    };

    expect(repairVoiceGrouping(withEmpty)).toBe(withEmpty);
    expect(entryWarnings(withEmpty).some((warning) => warning.kind === 'gnaural-regroup')).toBe(true);
  });
});

/** Two voices whose entries claim the same owner, which Gnaural would reopen as one. */
function merged(): Schedule {
  const base = ramp([10, 20, 30]);
  const claim = (voice: Voice, parent: string): Voice => ({
    ...voice,
    entries: voice.entries.map((entry) => ({ ...entry, preserved: { parent } })),
  });
  return { ...base, voices: [claim(base.voices[0], '0'), claim(base.voices[1], '0')] };
}

/** One voice whose entries claim two owners, which Gnaural would reopen as two. */
function split(): Schedule {
  const base = ramp([10, 20, 30]);
  const voice: Voice = {
    ...base.voices[0],
    entries: base.voices[0].entries.map((entry, index) => ({
      ...entry,
      preserved: { parent: index < 2 ? '0' : '1' },
    })),
  };
  return { ...base, voices: [voice] };
}

/** Lengthen or shorten one voice, so a schedule is ragged on purpose. */
function ripple(schedule: Schedule, voice: number, seconds: number): Schedule {
  const target = schedule.voices[voice];
  const last = target.entries.length - 1;
  return {
    ...schedule,
    voices: schedule.voices.map((current, index) =>
      index === voice
        ? {
            ...current,
            entries: current.entries.map((entry, at) =>
              at === last ? { ...entry, duration: entry.duration + seconds } : entry,
            ),
          }
        : current,
    ),
  };
}

function longest(schedule: Schedule): number {
  return Math.max(...schedule.voices.map(voiceDuration));
}
