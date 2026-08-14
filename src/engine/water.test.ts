import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { VoiceType } from '../document/types';
import { NOISE_BUFFER_SECONDS } from './noise';
import type { WaterField, WaterType } from './water';
import { createWaterBuffers, dropArray, waterDropCount, waterField, waterSeed } from './water';

const SAMPLE_RATE = 44100;

/** The reference defaults `main.c:3788` writes when each voice is created. */
const DROP_DEFAULTS = { drops: 2, probability: 0.000352858 };
const RAIN_DEFAULTS = { drops: 8, probability: 0.1 };

function context(sampleRate = SAMPLE_RATE): BaseAudioContext {
  return new OfflineAudioContext(2, sampleRate, sampleRate) as unknown as BaseAudioContext;
}

function field(overrides: Partial<WaterField> & { type: WaterType }): WaterField {
  return { ...DROP_DEFAULTS, mono: false, seed: 1, ...overrides };
}

function channels(spec: WaterField, sampleRate = SAMPLE_RATE): [Float32Array, Float32Array] {
  const [left, right] = createWaterBuffers(context(sampleRate), spec);
  return [left.getChannelData(0), right.getChannelData(0)];
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function peak(samples: Float32Array): number {
  return samples.reduce((worst, sample) => Math.max(worst, Math.abs(sample)), 0);
}

/** Fraction of 10 ms windows carrying anything audible — how *continuous* the texture is, which is
 *  the whole of the difference between a drip and a downpour. */
function activeFraction(samples: Float32Array, sampleRate = SAMPLE_RATE): number {
  const window = Math.round(0.01 * sampleRate);
  const windows = Math.floor(samples.length / window);
  let active = 0;
  for (let i = 0; i < windows; i++) {
    if (peak(samples.subarray(i * window, (i + 1) * window)) > 0.01) active++;
  }
  return active / windows;
}

/** The largest step between adjacent samples — the reference an unseamed loop would stand out
 *  against, exactly as `noise.test.ts` measures it. */
function maxDelta(samples: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i] - samples[i - 1]));
  return worst;
}

describe('the drop array (BB_WaterInit)', () => {
  /** Cycles of sine held in one drop: `arrayLength / pitch`, which is the whole of the pitch
   *  difference between the two types. Counted from the samples, so the constants in `WATER_SPECS`
   *  cannot drift from what the reference says without this failing. */
  const CYCLES: Record<WaterType, number> = {
    [VoiceType.WaterDrops]: 8192 / 600,
    [VoiceType.Rain]: 44 / 3.4,
  };

  function signChanges(array: Int16Array): number {
    let changes = 0;
    for (let i = 1; i < array.length; i++) if (array[i - 1] < 0 !== array[i] < 0) changes++;
    return changes;
  }

  it('ramps up to Gnaural’s full scale, so a drop played backwards decays', () => {
    const array = dropArray(VoiceType.WaterDrops);

    expect(array.length).toBe(8192);
    expect(array[0]).toBe(0); // a fresh slot plays this one sample: silent, so starting is not a click
    // The envelope is linear to 0x7fff; the peak sample is wherever the sine happens to be near it.
    expect(peakOf(array)).toBeGreaterThan(0x7fff * 0.9);
    expect(peakOf(array)).toBeLessThanOrEqual(0x7fff);
    expect(peakOf(array.subarray(0, 4096))).toBeLessThan(peakOf(array.subarray(4096)));
  });

  it('holds arrayLength / pitch cycles for each type', () => {
    for (const type of [VoiceType.WaterDrops, VoiceType.Rain] as WaterType[]) {
      // Two sign changes per cycle, ±1 for where the array's end falls within one.
      expect(Math.abs(signChanges(dropArray(type)) - 2 * CYCLES[type])).toBeLessThanOrEqual(1);
    }
  });

  function peakOf(array: Int16Array): number {
    return array.reduce((worst, value) => Math.max(worst, Math.abs(value)), 0);
  }
});

describe('waterDropCount (BB_WaterVoiceInit)', () => {
  it('truncates beatfreq, defaults below 1 to two slots and caps at a hundred', () => {
    expect(waterDropCount(8)).toBe(8);
    expect(waterDropCount(8.9)).toBe(8);
    expect(waterDropCount(0)).toBe(2);
    expect(waterDropCount(0.5)).toBe(2);
    expect(waterDropCount(-4)).toBe(2);
    // The reference substitutes its default only *below* one, so a single slot is reachable (:1141).
    expect(waterDropCount(1)).toBe(1);
    expect(waterDropCount(1000)).toBe(100);
  });

  it('reads the field off entry[0] alone, and a voice with no entries is silent', () => {
    const voice = {
      id: 0,
      description: '',
      type: VoiceType.Rain,
      muted: false,
      hidden: false,
      mono: false,
      preserved: {},
      entries: [
        { duration: 60, baseFreq: 0.05, beatFreq: 6, volumeLeft: 1, volumeRight: 1, preserved: {} },
        { duration: 60, baseFreq: 0.9, beatFreq: 90, volumeLeft: 1, volumeRight: 1, preserved: {} },
      ],
    };

    expect(waterField(voice, 3)).toEqual({
      type: VoiceType.Rain,
      drops: 6,
      probability: 0.05,
      mono: false,
      seed: waterSeed(3),
    });
    // `main.c:617` promises raindrop defaults for a voice left at zero; nothing below the GUI
    // supplies them, so what a bare voice really produces is silence.
    expect(waterField({ ...voice, entries: [] }, 0).probability).toBe(0);
  });
});

describe('createWaterBuffers', () => {
  it('is a full-length mono buffer per channel, at the context sample rate', () => {
    const [left, right] = createWaterBuffers(context(), field({ type: VoiceType.WaterDrops }));

    expect(left.numberOfChannels).toBe(1);
    expect(left.length).toBe(NOISE_BUFFER_SECONDS * SAMPLE_RATE);
    expect(right.length).toBe(left.length);
  });

  it('is reproducible from its seed — the property WAV export null-tests against playback', () => {
    const first = channels(field({ type: VoiceType.WaterDrops }))[0].subarray(0, 5000);
    const again = channels(field({ type: VoiceType.WaterDrops }))[0].subarray(0, 5000);

    expect(Array.from(first)).toEqual(Array.from(again));
    // And a different voice gets a different field, so two water voices are not one doubled.
    const other = channels(field({ type: VoiceType.WaterDrops, seed: waterSeed(1) }))[0];
    expect(Array.from(other.subarray(0, 5000))).not.toEqual(Array.from(first));
  });

  it('is silent at a probability of zero, which is what a hand-authored 0 means', () => {
    expect(peak(channels(field({ type: VoiceType.WaterDrops, probability: 0 }))[0])).toBe(0);
    expect(peak(channels(field({ type: VoiceType.Rain, probability: 0 }))[0])).toBe(0);
  });

  /**
   * The seam is the one place `noise.ts`'s approach would have been wrong: an equal-power crossfade
   * mixes two unrelated drop fields and ducks the level twice a loop. Adding the overhanging tail
   * back into the head is exact, so the wrap is no more abrupt than an ordinary sample step — and
   * the doubled `BB_LoPass` pass is what makes the *filter* periodic as well.
   */
  it('loops without a seam, for both types', () => {
    for (const spec of [
      field({ type: VoiceType.WaterDrops }),
      field({ type: VoiceType.Rain, ...RAIN_DEFAULTS }),
    ]) {
      const samples = channels(spec)[0];

      expect(Math.abs(samples[0] - samples[samples.length - 1])).toBeLessThanOrEqual(maxDelta(samples));
    }
  });

  it('gets louder with the probability and with the number of drops', () => {
    const levels = [0.0001, 0.000352858, 0.001, 0.01].map((probability) =>
      rms(channels(field({ type: VoiceType.WaterDrops, probability }))[0]),
    );
    const slots = [2, 4, 16].map((drops) => rms(channels(field({ type: VoiceType.WaterDrops, drops }))[0]));

    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
  });

  /**
   * The audible difference between the two types at their own defaults, and the reason rain is not
   * simply "faster drops": with `arraylen` 44 every playback rate lands at or past Nyquist, so rain
   * is a filtered impulse of 0.3–6.6 ms rather than a tick at a pitch, and at 0.1 per slot per
   * sample it never stops. Water drops leave most of the time silent.
   */
  it('makes rain a continuous texture and water drops a sparse one', () => {
    const drops = activeFraction(channels(field({ type: VoiceType.WaterDrops }))[0]);
    const rain = activeFraction(channels(field({ type: VoiceType.Rain, ...RAIN_DEFAULTS }))[0]);

    expect(drops).toBeLessThan(0.5);
    expect(rain).toBeGreaterThan(0.95);
  });

  /**
   * `voice_mono` changes the buffer, not the graph: every drop is mixed into both channels whole
   * (:1201) instead of being panned across them. The engine's shared downmix then computes
   * `(S + S) * 0.5 = S` (:835), so a mono water voice is centred *and* up to twice as loud per
   * channel as the stereo case — which is why it could not have been left to the graph.
   */
  it('mixes each drop whole into both channels under voice_mono', () => {
    const [left, right] = channels(field({ type: VoiceType.WaterDrops }));
    const [monoL, monoR] = channels(field({ type: VoiceType.WaterDrops, mono: true }));

    expect(Array.from(monoR)).toEqual(Array.from(monoL));
    // The same drops, differently mixed: mono is the stereo pair summed, give or take the `(int)`
    // truncation the reference applies to each panned drop.
    for (let i = 0; i < monoL.length; i += 997) {
      expect(monoL[i]).toBeCloseTo(left[i] + right[i], 2);
    }
    expect(rms(monoL)).toBeGreaterThan(rms(left) * 1.5);
  });

  /**
   * The stated deviation from the reference, which hardcodes 44100 and admits it does not know what
   * happens otherwise. Drop rate, drop pitch, drop length *and* the lowpass corner are all held in
   * seconds and Hz rather than in samples, so water drops sound the same at any rate.
   *
   * **Rain is the exception, and it is the signal rather than the code**: every one of its drops is
   * an impulse a sample or two long, and an impulse is not a rate-invariant object — halve the rate
   * and each one stands for twice as much time. Measured, rain is 8% quieter at 48 kHz and 1.9×
   * louder at 22.05 kHz. Pinned here so it stays a known quantity.
   */
  it('holds the drop texture steady across sample rates', () => {
    const reference = channels(field({ type: VoiceType.WaterDrops }));
    const half = channels(field({ type: VoiceType.WaterDrops }), 22050);
    const high = channels(field({ type: VoiceType.WaterDrops }), 48000);

    // As a ratio, since the levels themselves are small enough that a loose absolute tolerance
    // would pass whatever the normalisation did.
    expect(rms(half[0]) / rms(reference[0])).toBeCloseTo(1, 1);
    expect(rms(high[0]) / rms(reference[0])).toBeCloseTo(1, 1);
    // Same drops per second, so the same share of the time has something in it.
    expect(activeFraction(half[0], 22050)).toBeCloseTo(activeFraction(reference[0]), 1);

    const rain = rms(channels(field({ type: VoiceType.Rain, ...RAIN_DEFAULTS }))[0]);
    const rainHigh = rms(channels(field({ type: VoiceType.Rain, ...RAIN_DEFAULTS }), 48000)[0]);
    expect(rainHigh / rain).toBeCloseTo(44100 / 48000, 1);
  });

  /**
   * Level is Gnaural's own, `/0x3fff` like noise — loud, and deliberately so. Rain at full volume
   * peaks past full scale and the WAV clamp is what catches it, exactly as a type-1 noise voice at
   * volume 1 does; the reference's own defaults put both voices at 0.5.
   */
  it('sits at the level Gnaural mixes against a tone, which for rain is past full scale', () => {
    expect(peak(channels(field({ type: VoiceType.WaterDrops }))[0])).toBeGreaterThan(0.1);
    expect(peak(channels(field({ type: VoiceType.Rain, ...RAIN_DEFAULTS }))[0])).toBeGreaterThan(1);
  });
});
