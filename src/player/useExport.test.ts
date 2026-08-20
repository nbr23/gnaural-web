import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { silenceMutedVoices } from './useExport';
import type { VoiceGate } from './usePlayer';

function makeEntry(): Entry {
  return {
    duration: 300,
    baseFreq: 200,
    beatFreq: 8,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
  };
}

function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: 0,
    description: 'Carrier',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [makeEntry()],
    preserved: {},
    ...overrides,
  };
}

function scheduleOf(voices: Voice[]): Schedule {
  return {
    title: 'Program',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

const AUDIBLE: VoiceGate = { muted: false, soloed: false };
const MUTED: VoiceGate = { muted: true, soloed: false };

describe('silenceMutedVoices', () => {
  it('returns the document untouched when the gates agree with it', () => {
    const schedule = scheduleOf([makeVoice(), makeVoice({ id: 1, muted: true })]);

    expect(silenceMutedVoices(schedule, [AUDIBLE, MUTED])).toBe(schedule);
  });

  it('mutes a voice the session muted, and only that voice', () => {
    const schedule = scheduleOf([makeVoice(), makeVoice({ id: 1 })]);
    const gated = silenceMutedVoices(schedule, [AUDIBLE, MUTED]);

    expect(gated.voices.map((voice) => voice.muted)).toEqual([false, true]);
    expect(gated.voices[0]).toBe(schedule.voices[0]);
    expect(schedule.voices[1].muted).toBe(false);
  });

  it('un-mutes a voice the document muted and the session did not', () => {
    const schedule = scheduleOf([makeVoice({ muted: true })]);

    expect(silenceMutedVoices(schedule, [AUDIBLE]).voices[0].muted).toBe(false);
  });

  it('falls back to the document for voices the gates do not cover', () => {
    const schedule = scheduleOf([makeVoice({ muted: true }), makeVoice({ id: 1 })]);

    expect(silenceMutedVoices(schedule, []).voices.map((voice) => voice.muted)).toEqual([
      true,
      false,
    ]);
    expect(silenceMutedVoices(schedule, [])).toBe(schedule);
  });
});
