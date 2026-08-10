import { describe, expect, it } from 'vitest';
import { parseSchedule } from './parser';
import { loadFixture } from './test-fixtures';
import { longestVoiceDuration, scheduleDuration, voiceDuration } from './timing';
import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';

function makeVoice(durations: number[], overrides: Partial<Voice> = {}): Voice {
  const entries: Entry[] = durations.map((duration) => ({
    duration,
    baseFreq: 100,
    beatFreq: 4,
    volumeLeft: 1,
    volumeRight: 1,
    preserved: {},
  }));
  return { id: 0, description: '', type: VoiceType.Binaural, muted: false, hidden: false, mono: false, entries, preserved: {}, ...overrides };
}

function makeSchedule(voices: Voice[]): Schedule {
  return {
    title: '',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

describe('voiceDuration', () => {
  it('sums fractional entry durations without truncating (§3.8)', () => {
    expect(voiceDuration(makeVoice([13.1737, 6.5, 0.001]))).toBeCloseTo(19.6747, 6);
  });

  it('is zero for a voice with no entries', () => {
    expect(voiceDuration(makeVoice([]))).toBe(0);
  });
});

describe('scheduleDuration', () => {
  it('is the shortest voice, not the longest (§3.7)', () => {
    const schedule = makeSchedule([makeVoice([100]), makeVoice([30, 10]), makeVoice([60])]);

    expect(scheduleDuration(schedule)).toBe(40);
    expect(longestVoiceDuration(schedule)).toBe(100);
  });

  it('counts voices this app cannot render — any voice can end the schedule', () => {
    const schedule = makeSchedule([
      makeVoice([100]),
      makeVoice([12], { type: VoiceType.PinkNoise }),
      makeVoice([30], { type: VoiceType.Pcm }),
    ]);

    expect(scheduleDuration(schedule)).toBe(12);
  });

  it('counts hidden and muted voices — both still consume time (§3.2)', () => {
    const schedule = makeSchedule([makeVoice([100]), makeVoice([20], { hidden: true, muted: true })]);
    expect(scheduleDuration(schedule)).toBe(20);
  });

  it('is zero for a schedule with no voices', () => {
    expect(scheduleDuration(makeSchedule([]))).toBe(0);
    expect(longestVoiceDuration(makeSchedule([]))).toBe(0);
  });

  it('derives the fixture length from the entries, not the declared totaltime', () => {
    const schedule = parseSchedule(loadFixture('powernap.gnaural'));
    expect(scheduleDuration(schedule)).toBeCloseTo(1200, 6);
  });
});
