import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Entry, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent } from './compiler';
import { compileVoice, valueAtTime } from './compiler';

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 0, baseFreq: 0, beatFreq: 0, volumeLeft: 1, volumeRight: 1, preserved: {}, ...partial };
}

function makeVoice(entries: Entry[]): Voice {
  return {
    id: 0,
    description: '',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
  };
}

/** Re-implements linear interpolation between consecutive events, matching PLAN.md §3.5's
 *  `spread * factor + start` formula (which `linearRampToValueAtTime` implements exactly) — used
 *  here only to verify the compiled breakpoints reproduce the correct curve at arbitrary times. */
function interpolate(events: AutomationEvent[], t: number, key: keyof Omit<AutomationEvent, 'time'>): number {
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (t >= a.time && t <= b.time) {
      const factor = (t - a.time) / (b.time - a.time);
      return a[key] + (b[key] - a[key]) * factor;
    }
  }
  throw new Error(`t=${t} out of range`);
}

describe('compileVoice', () => {
  it('emits one event per entry plus a final wrap event', () => {
    const voice = makeVoice([
      makeEntry({ duration: 10, baseFreq: 100, beatFreq: 10 }),
      makeEntry({ duration: 5, baseFreq: 200, beatFreq: 20 }),
    ]);
    const events = compileVoice(voice);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.time)).toEqual([0, 10, 15]);
  });

  it('assigns the higher frequency to the left channel (§3.6)', () => {
    const voice = makeVoice([makeEntry({ duration: 10, baseFreq: 100, beatFreq: 10 })]);
    const [first] = compileVoice(voice);

    expect(first.leftFreq).toBe(105);
    expect(first.rightFreq).toBe(95);
  });

  it('wraps the final segment to entry[0]\'s values, unconditionally (§3.5)', () => {
    const voice = makeVoice([
      makeEntry({ duration: 10, baseFreq: 100, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 }),
      makeEntry({ duration: 20, baseFreq: 300, beatFreq: 40, volumeLeft: 1, volumeRight: 1 }),
    ]);
    const events = compileVoice(voice);
    const last = events[events.length - 1];

    expect(last.time).toBe(30);
    expect(last.leftFreq).toBe(105); // entry[0]'s values, not entry[1]'s
    expect(last.rightFreq).toBe(95);
    expect(last.leftGain).toBe(0.5);
    expect(last.rightGain).toBe(0.5);
  });

  it('interpolates linearly at segment midpoints, matching Gnaural\'s spread*factor+start formula', () => {
    const voice = makeVoice([
      makeEntry({ duration: 10, baseFreq: 100, beatFreq: 10 }), // left=105, right=95
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 20 }), // left=210, right=190
    ]);
    const events = compileVoice(voice);

    // First segment: entry[0] (105) -> entry[1] (210), midpoint at t=5.
    expect(interpolate(events, 5, 'leftFreq')).toBeCloseTo(157.5, 10);
    // Second segment: entry[1] (210) -> wrap to entry[0] (105), midpoint at t=15.
    expect(interpolate(events, 15, 'leftFreq')).toBeCloseTo(157.5, 10);
  });

  it('wraps a single-entry voice to itself, holding a constant value', () => {
    const voice = makeVoice([makeEntry({ duration: 10, baseFreq: 150, beatFreq: 6, volumeLeft: 0.8, volumeRight: 0.8 })]);
    const events = compileVoice(voice);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ time: 0, leftFreq: 153, rightFreq: 147, leftGain: 0.8, rightGain: 0.8 });
    expect(events[1]).toEqual({ time: 10, leftFreq: 153, rightFreq: 147, leftGain: 0.8, rightGain: 0.8 });
  });

  it('does not drop zero-value entries (beatfreq=0, silent volume)', () => {
    const voice = makeVoice([
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 0, volumeLeft: 0, volumeRight: 0 }),
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 10 }),
    ]);
    const events = compileVoice(voice);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ leftFreq: 200, rightFreq: 200, leftGain: 0, rightGain: 0 });
  });

  it('compiles an empty voice to no events', () => {
    expect(compileVoice(makeVoice([]))).toEqual([]);
  });

  it('compiles a real fixture voice correctly (powernap.gnaural)', () => {
    const schedule = parseSchedule(loadFixture('powernap.gnaural'));
    const voice = schedule.voices[0];
    const events = compileVoice(voice);
    const firstEntry = voice.entries[0];
    const totalDuration = voice.entries.reduce((sum, e) => sum + e.duration, 0);

    expect(events).toHaveLength(voice.entries.length + 1);
    expect(events[0]).toEqual({
      time: 0,
      leftFreq: firstEntry.baseFreq + firstEntry.beatFreq / 2,
      rightFreq: firstEntry.baseFreq - firstEntry.beatFreq / 2,
      leftGain: firstEntry.volumeLeft,
      rightGain: firstEntry.volumeRight,
    });

    const last = events[events.length - 1];
    expect(last.time).toBeCloseTo(totalDuration, 10);
    expect(last.leftFreq).toBe(firstEntry.baseFreq + firstEntry.beatFreq / 2);
    expect(last.rightFreq).toBe(firstEntry.baseFreq - firstEntry.beatFreq / 2);
  });
});

describe('valueAtTime', () => {
  const events = compileVoice(
    makeVoice([
      makeEntry({ duration: 10, baseFreq: 100, beatFreq: 10 }), // left=105, right=95, t=0
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 20 }), // left=210, right=190, t=10
      // wrap to entry[0] (left=105, right=95) at t=20
    ]),
  );

  it('returns the exact value at an event time', () => {
    expect(valueAtTime(events, 0)).toEqual({ leftFreq: 105, rightFreq: 95, leftGain: 1, rightGain: 1 });
    expect(valueAtTime(events, 10)).toEqual({ leftFreq: 210, rightFreq: 190, leftGain: 1, rightGain: 1 });
    expect(valueAtTime(events, 20)).toEqual({ leftFreq: 105, rightFreq: 95, leftGain: 1, rightGain: 1 });
  });

  it('interpolates linearly at a segment midpoint', () => {
    expect(valueAtTime(events, 5).leftFreq).toBeCloseTo(157.5, 10);
    expect(valueAtTime(events, 15).leftFreq).toBeCloseTo(157.5, 10);
  });

  it('clamps to the first value before the curve starts', () => {
    expect(valueAtTime(events, -5)).toEqual(valueAtTime(events, 0));
  });

  it('clamps to the last value after the curve ends', () => {
    expect(valueAtTime(events, 25)).toEqual(valueAtTime(events, 20));
  });

  it('returns silence for an empty event list', () => {
    expect(valueAtTime([], 5)).toEqual({ leftFreq: 0, rightFreq: 0, leftGain: 0, rightGain: 0 });
  });
});
