import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { NOISE_BUFFER_SECONDS, createNoiseBuffer, noiseSeeds } from './noise';

const SAMPLE_RATE = 44100;

function context(): BaseAudioContext {
  return new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE) as unknown as BaseAudioContext;
}

function channel(seed: number): Float32Array {
  return createNoiseBuffer(context(), seed).getChannelData(0);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** Fraction of adjacent sample pairs that straddle zero — a filter-strength proxy. */
function zeroCrossingRate(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  }
  return crossings / (samples.length - 1);
}

function correlation(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum / (a.length * rms(a) * rms(b));
}

describe('createNoiseBuffer', () => {
  it('is a full-length mono buffer at the context sample rate', () => {
    const buffer = createNoiseBuffer(context(), 1);

    expect(buffer.numberOfChannels).toBe(1);
    expect(buffer.length).toBe(NOISE_BUFFER_SECONDS * SAMPLE_RATE);
  });

  it('is reproducible from its seed — the property WAV export null-tests against playback', () => {
    expect(Array.from(channel(7).subarray(0, 500))).toEqual(Array.from(channel(7).subarray(0, 500)));
  });

  it('generates decorrelated streams for the two channels of a voice (§4.5)', () => {
    const [left, right] = noiseSeeds(0).map(channel);

    expect(Math.abs(correlation(left, right))).toBeLessThan(0.05);
  });

  it('gives each voice its own stream', () => {
    const [firstVoice] = noiseSeeds(0);
    const [secondVoice] = noiseSeeds(1);

    expect(Math.abs(correlation(channel(firstVoice), channel(secondVoice)))).toBeLessThan(0.05);
  });

  it("replicates BB_LoPass's rolloff rather than emitting white noise", () => {
    // A one-pole with a = 31/32 crosses zero with probability acos(a)/pi per sample (~0.080);
    // white noise would sit at 0.5. Measured is a shade higher (~0.086) because the integer
    // `>> 5` truncates rather than rounds, which leaks a little of the pole away — an artifact
    // of replicating the C exactly, so the bound is one-sided rather than a tight equality.
    const onePole = Math.acos(31 / 32) / Math.PI;
    const rate = zeroCrossingRate(channel(3));

    expect(rate).toBeGreaterThan(onePole * 0.9);
    expect(rate).toBeLessThan(onePole * 1.2);
  });

  it('sits at the level Gnaural mixes noise against a tone at (BB_SIN_SCALER)', () => {
    // Steady-state RMS is the white input's, reduced by sqrt((1-a)/(1+a)) with a = 31/32, then
    // scaled by 0x3FFF: about 0.29 against a sine's peak of 1. Loud, and deliberately so —
    // the reference's own TODO list admits noise at full volume breaks up (BinauralBeat.c:54).
    const level = rms(channel(11));

    expect(level).toBeGreaterThan(0.2);
    expect(level).toBeLessThan(0.4);
  });

  it('loops without a seam — no discontinuity from the last sample back to the first', () => {
    const samples = channel(5);

    let maxDelta = 0;
    for (let i = 1; i < samples.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(samples[i] - samples[i - 1]));
    }
    const seamDelta = Math.abs(samples[0] - samples[samples.length - 1]);

    // The wrap must be no more abrupt than an ordinary sample-to-sample step inside the buffer.
    expect(seamDelta).toBeLessThanOrEqual(maxDelta);
  });
});
