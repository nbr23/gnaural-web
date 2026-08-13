import { describe, expect, it } from 'vitest';
import { EEG_BANDS, bandCentre, bandFor } from '../viz/bands';
import { insertVoice } from './edit';
import type { GeneratorSpec } from './generators';
import { SLEEP_CYCLE_SECONDS, generateEntries } from './generators';
import { voiceDuration } from './timing';
import type { Schedule, Voice } from './types';
import { VoiceType } from './types';
import { entryWarnings } from './warnings';

const TONE = { baseFreq: 200, beatFreq: 10 };

/** Every shape, at a length long enough for the sleep cycle to repeat. */
function every(seconds: number): GeneratorSpec[] {
  return [
    { kind: 'hold', tone: TONE, seconds },
    { kind: 'ramp', from: TONE, to: { baseFreq: 120, beatFreq: 2 }, seconds, returnSeconds: 60 },
    { kind: 'sleep-cycle', baseFreq: 180, seconds },
    { kind: 'wake-up', baseFreq: 180, seconds, returnSeconds: 30 },
  ];
}

function voiceOf(entries: ReturnType<typeof generateEntries>): Voice {
  return {
    id: 0,
    description: 'Generated',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
  };
}

describe('generateEntries', () => {
  /**
   * The contract §3.5 forces: the last segment glides home whether or not the schedule loops, so a
   * shape has to pay for its own return out of the length it was given. Getting this exactly right
   * is what lets the panel default the duration to what the schedule already plays without making
   * it ragged (§3.7).
   */
  it('totals exactly the duration it was asked for, return leg included', () => {
    for (const spec of every(3 * SLEEP_CYCLE_SECONDS)) {
      expect(voiceDuration(voiceOf(generateEntries(spec)))).toBeCloseTo(3 * SLEEP_CYCLE_SECONDS, 9);
    }
  });

  it('produces a legal voice for every shape — at least one entry, every duration positive', () => {
    for (const spec of every(1200)) {
      const entries = generateEntries(spec);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.duration).toBeGreaterThan(0);
    }
  });

  it('makes nothing at all from a zero or negative duration', () => {
    expect(generateEntries({ kind: 'hold', tone: TONE, seconds: 0 })).toEqual([]);
    expect(generateEntries({ kind: 'ramp', from: TONE, to: TONE, seconds: -5, returnSeconds: 1 })).toEqual([]);
  });

  it('holds at one value, in one entry — the same document Live mode builds', () => {
    const entries = generateEntries({ kind: 'hold', tone: TONE, seconds: 600 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ duration: 600, baseFreq: 200, beatFreq: 10 });
  });

  it('ramps from one tone to the other, then home over the return leg', () => {
    const entries = generateEntries({
      kind: 'ramp',
      from: TONE,
      to: { baseFreq: 120, beatFreq: 2 },
      seconds: 1200,
      returnSeconds: 60,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ duration: 1140, baseFreq: 200, beatFreq: 10 });
    expect(entries[1]).toMatchObject({ duration: 60, baseFreq: 120, beatFreq: 2 });
  });

  /** A return of zero would read as an instant jump at the very end, so it is floored, not honoured. */
  it('never gives the closing entry a zero duration', () => {
    const entries = generateEntries({
      kind: 'ramp',
      from: TONE,
      to: TONE,
      seconds: 1000,
      returnSeconds: 0,
    });

    expect(entries[1].duration).toBeGreaterThan(0);
    expect(entries[0].duration + entries[1].duration).toBeCloseTo(1000, 9);
  });

  it('repeats the sleep cycle about every ninety minutes, and needs no return leg', () => {
    const one = generateEntries({ kind: 'sleep-cycle', baseFreq: 180, seconds: SLEEP_CYCLE_SECONDS });
    const four = generateEntries({
      kind: 'sleep-cycle',
      baseFreq: 180,
      seconds: 4 * SLEEP_CYCLE_SECONDS,
    });

    expect(four).toHaveLength(4 * one.length);
    // Each cycle opens where the one before it closes — §3.5's wrap is what carries the last one home.
    expect(four[one.length].beatFreq).toBe(four[0].beatFreq);
    expect(one[0].beatFreq).toBeGreaterThan(one[2].beatFreq);
  });

  it('reaches delta in the sleep cycle and beta on the wake-up ramp', () => {
    const sleep = generateEntries({ kind: 'sleep-cycle', baseFreq: 180, seconds: SLEEP_CYCLE_SECONDS });
    const wake = generateEntries({
      kind: 'wake-up',
      baseFreq: 180,
      seconds: 600,
      returnSeconds: 30,
    });

    expect(bandFor(Math.min(...sleep.map((entry) => entry.beatFreq)))?.name).toBe('Delta');
    expect(bandFor(wake[0].beatFreq)?.name).toBe('Delta');
    expect(bandFor(wake[1].beatFreq)?.name).toBe('Beta');
  });

  it('holds the base frequency it was given across a shape that only moves the beat', () => {
    const entries = generateEntries({ kind: 'sleep-cycle', baseFreq: 137, seconds: 3600 });
    expect(entries.every((entry) => entry.baseFreq === 137)).toBe(true);
  });

  /** Step 6's argument, inherited: a generated voice must not be the clipping case either. */
  it('generates at the same level a newly added voice gets', () => {
    const generated = generateEntries({ kind: 'hold', tone: TONE, seconds: 60 })[0];
    const added = insertVoice(blank(), { kind: 'tone' }).schedule.voices[0].entries[0];

    expect(generated.volumeLeft).toBe(added.volumeLeft);
    expect(generated.volumeRight).toBe(added.volumeRight);
  });

  it('carries no preserved data, so the serializer derives each entry’s owner', () => {
    for (const spec of every(600)) {
      for (const entry of generateEntries(spec)) expect(entry.preserved).toEqual({});
    }
  });
});

describe('EEG band presets', () => {
  it('takes the geometric centre of the band itself', () => {
    const centres = Object.fromEntries(EEG_BANDS.map((band) => [band.name, bandCentre(band)]));

    expect(centres.Delta).toBeCloseTo(1.4142, 3);
    expect(centres.Alpha).toBeCloseTo(10.198, 3);
    expect(centres.Gamma).toBeCloseTo(54.772, 3);
  });

  it('lands each preset inside the band it is named for', () => {
    for (const band of EEG_BANDS) expect(bandFor(bandCentre(band))?.name).toBe(band.name);
  });

  /**
   * Generators are deliberately **not** clamped to Live mode's slider range, so the Gamma preset sits
   * above §6.1's 40 Hz beat ceiling and step 7 says so — as a *notice*, because a 70 Hz beat plays
   * exactly as authored in four shipped presets too. A tool that quietly moved the value instead
   * would be discarding §6.1's own advice.
   */
  it('raises step 7’s beat notice for Gamma, and nothing at all for the rest', () => {
    for (const band of EEG_BANDS) {
      const entries = generateEntries({
        kind: 'hold',
        tone: { baseFreq: 200, beatFreq: bandCentre(band) },
        seconds: 600,
      });
      const warnings = entryWarnings({ ...blank(), voices: [voiceOf(entries)] });

      expect(warnings.filter((warning) => warning.severity === 'warning')).toEqual([]);
      expect(warnings.map((warning) => warning.kind)).toEqual(
        band.name === 'Gamma' ? ['beat-above-band'] : [],
      );
    }
  });
});

function blank(): Schedule {
  return {
    title: '',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [],
    preserved: {},
  };
}
