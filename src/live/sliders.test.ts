import { describe, expect, it } from 'vitest';
import { BASE_RANGE, BEAT_RANGE } from './liveSchedule';
import { bandTargets, beatBandTicks, positionToValue, valueToPosition } from './sliders';

describe('the log slider mapping', () => {
  it('hits both ends exactly', () => {
    expect(positionToValue(BASE_RANGE, 0)).toBe(BASE_RANGE.min);
    expect(positionToValue(BASE_RANGE, 1)).toBe(BASE_RANGE.max);
    expect(positionToValue(BEAT_RANGE, 0)).toBe(BEAT_RANGE.min);
    expect(positionToValue(BEAT_RANGE, 1)).toBe(BEAT_RANGE.max);
  });

  it('inverts, within the rounding the range declares', () => {
    for (const hz of [40, 63.2, 110, 200, 440, 799.9]) {
      expect(positionToValue(BASE_RANGE, valueToPosition(BASE_RANGE, hz))).toBeCloseTo(hz, 1);
    }
    for (const hz of [0.5, 1.4, 4, 10, 19.7, 40]) {
      expect(positionToValue(BEAT_RANGE, valueToPosition(BEAT_RANGE, hz))).toBeCloseTo(hz, 2);
    }
  });

  it('clamps a position outside 0..1 rather than extrapolating off the range', () => {
    expect(positionToValue(BEAT_RANGE, -3)).toBe(BEAT_RANGE.min);
    expect(positionToValue(BEAT_RANGE, 7)).toBe(BEAT_RANGE.max);
  });

  it('gives the low end of the beat slider the travel a linear scale would not', () => {
    // Delta (0.5–4 Hz) is what every sleep program uses. Linearly it would be 9% of the slider.
    expect(valueToPosition(BEAT_RANGE, 4)).toBeGreaterThan(0.4);
    // And the mid-point lands in theta rather than up in beta.
    expect(positionToValue(BEAT_RANGE, 0.5)).toBeLessThan(8);
  });
});

describe('EEG band affordances', () => {
  it('marks the band boundaries inside the range, and neither end of the slider', () => {
    // 0.5 is the slider's own minimum and 100 is past its maximum: a tick on the thumb's resting
    // place says nothing, and one off the end cannot be drawn.
    expect(beatBandTicks()).toEqual([4, 8, 13, 30]);
  });

  it('offers one jump target per reachable band, inside that band', () => {
    const targets = bandTargets();

    expect(targets.map((target) => target.band.name)).toEqual([
      'Delta',
      'Theta',
      'Alpha',
      'Beta',
      'Gamma',
    ]);

    for (const { band, beatFreq } of targets) {
      expect(beatFreq).toBeGreaterThanOrEqual(band.min);
      expect(beatFreq).toBeLessThan(band.max);
      expect(beatFreq).toBeLessThanOrEqual(BEAT_RANGE.max);
    }
  });

  it("puts Gamma inside the reachable part of the band rather than against the slider's end", () => {
    // Gamma runs 30–100 Hz and the slider stops at §6.1's 40. Centring on the whole band would
    // pin the chip to the maximum, which is not a statement about the band.
    const gamma = bandTargets().find((target) => target.band.name === 'Gamma');

    expect(gamma?.beatFreq).toBeGreaterThan(30);
    expect(gamma?.beatFreq).toBeLessThan(BEAT_RANGE.max);
  });
});
