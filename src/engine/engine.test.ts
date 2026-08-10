import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { playSchedule } from './engine';

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 0, baseFreq: 0, beatFreq: 0, volumeLeft: 1, volumeRight: 1, preserved: {}, ...partial };
}

function makeVoice(entries: Entry[], overrides: Partial<Voice> = {}): Voice {
  return {
    id: 0,
    description: '',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
    ...overrides,
  };
}

function makeSchedule(voices: Voice[], overrides: Partial<Schedule> = {}): Schedule {
  return {
    title: '',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
    ...overrides,
  };
}

/** Zero-crossing frequency estimate — accurate for a clean, constant-amplitude sine segment. */
function estimateFrequency(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  }
  return crossings / (samples.length / sampleRate);
}

function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

const SAMPLE_RATE = 44100;

describe('playSchedule', () => {
  it('produces independent L/R tones whose frequency difference equals the beat frequency (§3.6)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE); // 1 second
    const schedule = makeSchedule([makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 10 })])]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();

    const freqL = estimateFrequency(buffer.getChannelData(0), SAMPLE_RATE);
    const freqR = estimateFrequency(buffer.getChannelData(1), SAMPLE_RATE);

    expect(freqL).toBeGreaterThan(freqR); // left carries the higher frequency
    expect(freqL - freqR).toBeCloseTo(10, 0);
    // Zero-crossing counting has ~1 Hz resolution over a 1-second window.
    expect(Math.abs(freqL - 305)).toBeLessThan(1.5);
    expect(Math.abs(freqR - 295)).toBeLessThan(1.5);
  });

  it('has no discontinuities across a segment boundary (phase-continuous frequency ramp)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE); // 1 second
    const schedule = makeSchedule([
      makeVoice([
        makeEntry({ duration: 0.5, baseFreq: 300, beatFreq: 10 }),
        makeEntry({ duration: 0.5, baseFreq: 400, beatFreq: 20 }),
      ]),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);

    let maxDelta = 0;
    for (let i = 1; i < left.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(left[i] - left[i - 1]));
    }
    // A phase-continuous sine at these frequencies/sample rate never jumps more than ~0.06 per
    // sample; a mis-scheduled setValueAtTime instead of a ramp would produce a much larger jump.
    expect(maxDelta).toBeLessThan(0.2);
  });

  it('applies master volume per channel after summing voices (§3.2)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule(
      [makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 0 })])],
      { masterVolume: { left: 0.5, right: 1 } },
    );

    playSchedule(context, schedule);
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBeCloseTo(0.5, 1);
    expect(peakAmplitude(buffer.getChannelData(1))).toBeCloseTo(1, 1);
  });

  it('sums multiple simultaneous voices', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 0 })]),
      makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 0 })], { id: 1 }),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();

    // Two identical in-phase sine voices summed should peak near 2x a single voice's amplitude.
    expect(peakAmplitude(buffer.getChannelData(0))).toBeGreaterThan(1.5);
  });

  it('skips non-binaural voice types without throwing', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 1, baseFreq: 300 })], { type: VoiceType.PinkNoise }),
    ]);

    expect(() => playSchedule(context, schedule)).not.toThrow();
    const buffer = await context.startRendering();
    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });
});
