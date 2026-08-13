import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import {
  GATE_STEEPNESS,
  MIN_GATE_FREQ,
  cosineGateWave,
  gateCurve,
  gateEdgeSeconds,
} from './isochronic';

const SAMPLE_RATE = 44100;

/** Where the curve reads at input `x`, the way a `WaveShaperNode` indexes it. */
function at(curve: Float32Array, x: number): number {
  return curve[Math.round(((x + 1) / 2) * (curve.length - 1))];
}

describe('the isochronic gate curve', () => {
  it('is a 0..1 gate, saturated at both ends', () => {
    const curve = gateCurve();

    expect(curve[0]).toBe(0);
    expect(curve[curve.length - 1]).toBe(1);
    expect(Math.min(...curve)).toBe(0);
    expect(Math.max(...curve)).toBe(1);
  });

  it('is monotonic', () => {
    const curve = gateCurve();

    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
  });

  /**
   * The reference's gate is on for exactly half of each period, because its countdown is a *half*
   * period and the polarity flag flips every time it runs out (BinauralBeat.c:609, :761). A curve
   * symmetric about zero gives a cosine the same 50% duty without counting anything.
   */
  it('is symmetric about zero, which is what makes the duty cycle 50%', () => {
    const curve = gateCurve();

    for (let i = 0; i < curve.length; i++) {
      expect(curve[i] + curve[curve.length - 1 - i]).toBeCloseTo(1, 6);
    }
    expect(at(curve, 0)).toBeCloseTo(0.5, 6);
  });

  it('inverts to exactly its own complement — the type-4 right channel (§3.3)', () => {
    const curve = gateCurve();
    const inverted = gateCurve(true);

    for (let i = 0; i < curve.length; i++) expect(curve[i] + inverted[i]).toBeCloseTo(1, 6);
  });

  it('saturates at ±1/k, so the edge is the only part that is not flat', () => {
    const curve = gateCurve();

    expect(at(curve, 1 / GATE_STEEPNESS + 0.01)).toBe(1);
    expect(at(curve, -1 / GATE_STEEPNESS - 0.01)).toBe(0);
    expect(at(curve, 1 / GATE_STEEPNESS - 0.01)).toBeLessThan(1);
  });
});

describe('the gate edge', () => {
  /**
   * `GATE_STEEPNESS` exists to put the edge at the reference's own 100 samples at 44.1 kHz, and
   * nothing else pins that number — so this is the assertion that would fail if it were changed
   * without deciding to.
   */
  it('matches Gnaural’s 100-sample ramp at a 10 Hz beat', () => {
    expect(gateEdgeSeconds(10)).toBeCloseTo(100 / 44100, 4);
  });

  it('scales as 1/f — the documented deviation from the reference’s fixed edge', () => {
    expect(gateEdgeSeconds(4)).toBeCloseTo(gateEdgeSeconds(40) * 10, 6);
  });

  /** Rendered rather than reasoned about: the shaped cosine really does cross in the time the
   *  formula says, which is what the comments in `isochronic.ts` claim. */
  it('measures on a rendered signal as the formula predicts', async () => {
    const beat = 10;
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);

    const shaper = ctx.createWaveShaper();
    shaper.curve = gateCurve();
    const gate = ctx.createOscillator();
    gate.setPeriodicWave(cosineGateWave(ctx as unknown as BaseAudioContext));
    gate.frequency.value = beat;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const carrier = ctx.createConstantSource();
    carrier.offset.value = 1;

    gate.connect(shaper);
    shaper.connect(gain.gain);
    carrier.connect(gain).connect(ctx.destination);
    gate.start(0);
    carrier.start(0);

    const rendered = (await ctx.startRendering()).getChannelData(0);

    // The first fall: fully on, through the edge, to fully off.
    let from = -1;
    let to = -1;
    for (let i = 1; i < rendered.length; i++) {
      if (from < 0 && rendered[i] < 1 && rendered[i - 1] >= 1) from = i;
      if (from > 0 && rendered[i] <= 0) {
        to = i;
        break;
      }
    }

    expect((to - from) / SAMPLE_RATE).toBeCloseTo(gateEdgeSeconds(beat), 4);

    // 50% duty: the mean of a gate that is on half the time and symmetric across both edges.
    let sum = 0;
    for (const sample of rendered) sum += sample;
    expect(sum / rendered.length).toBeCloseTo(0.5, 2);
  });

  /**
   * `beatfreq = 0` is a steady tone in the reference, whose polarity flag never flips (:592).
   * A cosine at the floor frequency is what reproduces that; a plain sine would sit at the middle
   * of the curve and leave the gate half open.
   */
  it('holds the gate fully open at the beat-frequency floor', async () => {
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);

    const shaper = ctx.createWaveShaper();
    shaper.curve = gateCurve();
    const gate = ctx.createOscillator();
    gate.setPeriodicWave(cosineGateWave(ctx as unknown as BaseAudioContext));
    gate.frequency.value = MIN_GATE_FREQ;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const carrier = ctx.createConstantSource();
    carrier.offset.value = 1;

    gate.connect(shaper);
    shaper.connect(gain.gain);
    carrier.connect(gain).connect(ctx.destination);
    gate.start(0);
    carrier.start(0);

    const rendered = (await ctx.startRendering()).getChannelData(0);

    expect(rendered[0]).toBe(1);
    expect(rendered[rendered.length - 1]).toBe(1);
  });
});

describe('the gate waveform', () => {
  /** `disableNormalization` is load-bearing rather than tidy: the curve's clamp points are stated
   *  in units of the oscillator's amplitude, so a normalised wave would move the edge. */
  it('is a unit-amplitude cosine, so the curve’s clamp points mean what they say', async () => {
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const gate = ctx.createOscillator();
    gate.setPeriodicWave(cosineGateWave(ctx as unknown as BaseAudioContext));
    gate.frequency.value = 1;
    gate.connect(ctx.destination);
    gate.start(0);

    const rendered = (await ctx.startRendering()).getChannelData(0);

    expect(rendered[0]).toBeCloseTo(1, 4); // cosine phase, not sine
    expect(rendered[Math.round(SAMPLE_RATE / 2)]).toBeCloseTo(-1, 3);
    expect(Math.max(...rendered)).toBeCloseTo(1, 4);
  });
});
