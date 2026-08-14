import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it, vi } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { compileVoice, valueAtTime } from './compiler';
import { moveVoice, removeVoice, updateSchedule } from '../document/edit';
import type { Horizon, NoiseLayerSettings } from './engine';
import { CLICK_FREE_RAMP, PlaybackEngine, playSchedule } from './engine';

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

  it('skips voice types it cannot render, without throwing (§3.3)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 1, baseFreq: 300 })], { type: VoiceType.Pcm }),
    ]);

    expect(() => playSchedule(context, schedule)).not.toThrow();
    const buffer = await context.startRendering();
    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });
});

describe('noise voices (type 1, §4.5a)', () => {
  it('renders audible decorrelated noise on both channels', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 10 })], { type: VoiceType.PinkNoise }),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    expect(peakAmplitude(left)).toBeGreaterThan(0.5);
    // Independent streams per channel: a binaural voice's two channels are near-identical sines,
    // noise's are unrelated sample for sample.
    expect(left.slice(0, 100)).not.toEqual(right.slice(0, 100));
  });

  it('follows its volume envelope like any other voice', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice(
        [
          makeEntry({ duration: 1, volumeLeft: 1, volumeRight: 1 }),
          makeEntry({ duration: 1, volumeLeft: 0, volumeRight: 0 }),
        ],
        { type: VoiceType.PinkNoise },
      ),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);

    const head = peakAmplitude(left.subarray(0, Math.round(0.1 * SAMPLE_RATE)));
    const tail = peakAmplitude(left.subarray(Math.round(0.9 * SAMPLE_RATE)));
    expect(tail).toBeLessThan(head * 0.3);
  });

  it('keeps sounding across transport transitions, though buffer sources are single-use', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(
      makeSchedule([makeVoice([makeEntry({ duration: 30 })], { type: VoiceType.PinkNoise })]),
    );

    engine.play();
    engine.pause();
    engine.play();
    engine.seek(12);

    const buffer = await context.startRendering();
    // An `AudioBufferSourceNode` cannot be restarted, so a voice that was not rebuilt on each
    // transition would be silent from the pause onwards.
    expect(peakAmplitude(buffer.getChannelData(0).subarray(Math.round(0.2 * SAMPLE_RATE)))).toBeGreaterThan(0.3);
  });

  it('honours mute and the mono downmix', async () => {
    const muted = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    playSchedule(
      muted,
      makeSchedule([makeVoice([makeEntry({ duration: 2 })], { type: VoiceType.PinkNoise, muted: true })]),
    );
    expect(peakAmplitude((await muted.startRendering()).getChannelData(0))).toBe(0);

    const mono = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    playSchedule(
      mono,
      makeSchedule([
        makeVoice([makeEntry({ duration: 2, volumeLeft: 1, volumeRight: 0.5 })], {
          type: VoiceType.PinkNoise,
          mono: true,
        }),
      ]),
    );
    const downmixed = await mono.startRendering();

    // Both channels carry the same (L+R)/2 stream, scaled only by their own volume (§3.2).
    for (let i = 0; i < downmixed.length; i += 997) {
      expect(downmixed.getChannelData(1)[i]).toBeCloseTo(downmixed.getChannelData(0)[i] * 0.5, 5);
    }
  });
});

/**
 * Types 3 and 4 (§3.3): one carrier at `basefreq`, switched on and off at `beatfreq`.
 *
 * These assert against `playSchedule` — the export path — because it is the simpler of the two
 * graphs and the one §5.3's null test proves the other equal to. What is measured is the gate:
 * a 50% duty cycle, a rate that follows `beatfreq`, and the two channels' relationship, which is
 * the whole of the difference between type 3 and type 4.
 */
describe('isochronic voices (types 3 and 4, §3.3)', () => {
  /**
   * Peak amplitude per 10 ms window — the pulse train with the carrier taken out of it.
   *
   * The window has to be *short against the gate* and *long against the carrier*: a sine crosses
   * zero twice per cycle, so a per-sample threshold reads the carrier rather than the gate, and a
   * window as long as half a pulse cannot tell an open gate from a closed one. 10 ms holds at least
   * three cycles of every carrier used here and at most a sixth of the shortest gate half-period.
   */
  const ENVELOPE_WINDOW = Math.round(0.01 * SAMPLE_RATE);

  function envelope(samples: Float32Array): number[] {
    const windows = Math.floor(samples.length / ENVELOPE_WINDOW);
    return Array.from({ length: windows }, (_unused, i) =>
      peakAmplitude(samples.subarray(i * ENVELOPE_WINDOW, (i + 1) * ENVELOPE_WINDOW)),
    );
  }

  /**
   * How many times the gate *opens* across the samples given — the pulse rate, if that is a second.
   *
   * A run already in progress at the start is not counted: the gate is a cosine, so it opens at
   * t=0, and any window into the middle of a schedule begins part-way through a pulse. Counting
   * that one would report n+1 pulses for n periods.
   */
  function pulseCount(samples: Float32Array): number {
    const levels = envelope(samples);
    const threshold = Math.max(...levels) * 0.5;
    let pulses = 0;
    levels.forEach((level, i) => {
      if (i > 0 && level > threshold && levels[i - 1] <= threshold) pulses++;
    });
    return pulses;
  }

  /** Fraction of the time the gate is open, from the same envelope. */
  function dutyCycle(samples: Float32Array): number {
    const levels = envelope(samples);
    const threshold = Math.max(...levels) * 0.5;
    return levels.filter((level) => level > threshold).length / levels.length;
  }

  async function render(schedule: Schedule, seconds = 1): Promise<AudioBuffer> {
    const context = new OfflineAudioContext(2, seconds * SAMPLE_RATE, SAMPLE_RATE);
    playSchedule(context, schedule);
    return context.startRendering();
  }

  function isochronic(entries: Entry[], overrides: Partial<Voice> = {}): Voice {
    return makeVoice(entries, { type: VoiceType.IsoPulse, ...overrides });
  }

  it('gates one carrier at basefreq, identically in both ears', async () => {
    const buffer = await render(
      makeSchedule([isochronic([makeEntry({ duration: 4, baseFreq: 300, beatFreq: 1 })])]),
    );
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    // Measured inside one open pulse. The gate is a cosine, so at 1 Hz it is open from the start
    // until 0.25 s; a whole-second estimate would count only the crossings that survive the gate
    // and read a fraction of the carrier rather than the carrier.
    const open = left.subarray(Math.round(0.02 * SAMPLE_RATE), Math.round(0.24 * SAMPLE_RATE));
    expect(Math.abs(estimateFrequency(open, SAMPLE_RATE) - 300)).toBeLessThan(6);

    // The §3.6 split does not happen here — both channels carry the same tone (BinauralBeat.c:598).
    for (let i = 0; i < left.length; i += 499) expect(right[i]).toBe(left[i]);
  });

  it('pulses at the beat frequency, on for half of each period', async () => {
    const buffer = await render(
      makeSchedule([isochronic([makeEntry({ duration: 4, baseFreq: 400, beatFreq: 8 })])]),
    );
    const left = buffer.getChannelData(0);

    expect(pulseCount(left)).toBe(8);
    // 50%, plus the windows straddling each of the sixteen edges (BinauralBeat.c:609 — the
    // countdown is a *half* period, so on and off are equal by construction).
    expect(dutyCycle(left)).toBeGreaterThan(0.45);
    expect(dutyCycle(left)).toBeLessThan(0.65);
  });

  it('alternates between the ears for type 4, and only for type 4', async () => {
    const entries = [makeEntry({ duration: 4, baseFreq: 400, beatFreq: 4 })];

    const plain = await render(makeSchedule([isochronic(entries)]));
    const alternating = await render(
      makeSchedule([isochronic(entries, { type: VoiceType.IsoPulseAlt })]),
    );

    expect(envelope(plain.getChannelData(0))).toEqual(envelope(plain.getChannelData(1)));
    // Type 3 is silent between pulses; type 4 never is, which is the whole difference.
    expect(Math.min(...envelope(plain.getChannelData(1)))).toBeLessThan(0.05);

    const left = envelope(alternating.getChannelData(0));
    const right = envelope(alternating.getChannelData(1));
    expect(Math.min(...left)).toBeLessThan(0.05); // each ear does go fully silent
    expect(Math.min(...right)).toBeLessThan(0.05);
    left.forEach((value, i) => {
      // …but never both at once: the pulse is in one ear or the other (BinauralBeat.c:788-801).
      expect(Math.max(value, right[i])).toBeGreaterThan(0.9);
    });
  });

  /**
   * The trap the graph is built around: `voice_mono` makes both channels the same downmix node, and
   * a single shared gate gain would be connected to it twice — a no-op the second time — leaving a
   * mono type-3 voice 6 dB down. The reference computes `(L + R) * 0.5` over two separately
   * computed samples (`:839`), and for type 3 those are equal, so mono changes nothing at all.
   */
  it('is unchanged by voice_mono when both channels are already identical (type 3)', async () => {
    const entries = [makeEntry({ duration: 4, baseFreq: 300, beatFreq: 4 })];

    const stereo = await render(makeSchedule([isochronic(entries)]));
    const mono = await render(makeSchedule([isochronic(entries, { mono: true })]));

    expect(peakAmplitude(mono.getChannelData(0))).toBeCloseTo(
      peakAmplitude(stereo.getChannelData(0)),
      5,
    );
    expect(peakAmplitude(mono.getChannelData(0))).toBeGreaterThan(0.9);
  });

  /**
   * The same downmix on a type-4 voice sums two complementary gates, so the pulsing cancels
   * completely and what is left is a steady tone at half level. That is what the reference
   * computes; it is reproduced rather than special-cased.
   */
  it('cancels type 4’s alternation under voice_mono, leaving a steady half-level tone', async () => {
    const buffer = await render(
      makeSchedule([
        isochronic([makeEntry({ duration: 4, baseFreq: 300, beatFreq: 4 })], {
          type: VoiceType.IsoPulseAlt,
          mono: true,
        }),
      ]),
    );

    for (const level of envelope(buffer.getChannelData(0))) expect(level).toBeCloseTo(0.5, 2);
  });

  /** `beatfreq = 0` is legitimate and means a steady tone: the reference's polarity flag never
   *  flips (BinauralBeat.c:592). A gate that sat half open would be 6 dB down and audibly wrong. */
  it('plays a steady tone at beatfreq 0, not a half-open gate', async () => {
    const buffer = await render(
      makeSchedule([isochronic([makeEntry({ duration: 4, baseFreq: 300, beatFreq: 0 })])]),
    );

    for (const level of envelope(buffer.getChannelData(0))) expect(level).toBeCloseTo(1, 2);
  });

  it('follows a beat ramp without a discontinuity', async () => {
    // One ramp across the whole render: §3.5's wrap means a second entry would ramp straight back,
    // and the two halves would then carry the same pulses in the opposite order.
    const buffer = await render(
      makeSchedule([
        isochronic([
          makeEntry({ duration: 2, baseFreq: 400, beatFreq: 4 }),
          makeEntry({ duration: 2, baseFreq: 400, beatFreq: 20 }),
        ]),
      ]),
      2,
    );
    const left = buffer.getChannelData(0);

    const first = pulseCount(left.subarray(0, Math.round(0.5 * SAMPLE_RATE)));
    const last = pulseCount(left.subarray(Math.round(1.5 * SAMPLE_RATE)));
    expect(last).toBeGreaterThan(first * 1.5);

    // The gate oscillator keeps its phase across the ramp, which is what the reference spends ten
    // lines rescaling a sample counter to achieve (`:602-612`). A gate that jumped would step.
    let maxDelta = 0;
    for (let i = 1; i < left.length; i++) maxDelta = Math.max(maxDelta, Math.abs(left[i] - left[i - 1]));
    expect(maxDelta).toBeLessThan(0.2);
  });

  it('follows its volume envelope like any other voice', async () => {
    // One second of the two-second voice, so the measurement is inside the fall and not past the
    // wrap that takes it back up (§3.5).
    const buffer = await render(
      makeSchedule([
        isochronic([
          makeEntry({ duration: 1, baseFreq: 300, beatFreq: 10, volumeLeft: 1, volumeRight: 1 }),
          makeEntry({ duration: 1, baseFreq: 300, beatFreq: 10, volumeLeft: 0, volumeRight: 0 }),
        ]),
      ]),
    );
    const left = buffer.getChannelData(0);

    const head = peakAmplitude(left.subarray(0, Math.round(0.1 * SAMPLE_RATE)));
    const tail = peakAmplitude(left.subarray(Math.round(0.9 * SAMPLE_RATE)));
    expect(head).toBeGreaterThan(0.9);
    expect(tail).toBeLessThan(head * 0.2);
  });

  /**
   * A change of `type` is one of the three things `requiresVoiceRebuild` fires on, so this is the
   * crossfade path with a new caller. It genuinely needs a mid-render edit — a crossfade exists only
   * across a transition during playback — which is what `renderWithEditAt` is for.
   */
  it('crossfades rather than cutting when a voice becomes isochronic mid-playback', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const binaural = makeSchedule([
      makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0, volumeLeft: 0.5, volumeRight: 0.5 })]),
    ]);
    engine.load(binaural);
    engine.play();

    const buffer = await renderWithEditAt(context, 0.5, () =>
      engine.update(
        makeSchedule([
          makeVoice(
            [makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0, volumeLeft: 0.5, volumeRight: 0.5 })],
            { type: VoiceType.IsoPulse },
          ),
        ]),
      ),
    );
    const left = buffer.getChannelData(0);

    // Beat 0 either side, so both documents are a steady 300 Hz tone and the swap is inaudible in
    // frequency — what is measured is that the level never drops out and never steps.
    expect(peakAmplitude(left.subarray(Math.round(0.7 * SAMPLE_RATE)))).toBeGreaterThan(0.4);
    let maxDelta = 0;
    for (let i = 1; i < left.length; i++) maxDelta = Math.max(maxDelta, Math.abs(left[i] - left[i - 1]));
    expect(maxDelta).toBeLessThan(0.2);
  });
});

/**
 * Types 5 and 6 (§3.3): a field of drops, seeded and looped like noise but generated from
 * `entry[0]` alone — `basefreq` is the chance per sample that a drop starts and `beatfreq` is how
 * many can overlap. `water.test.ts` measures the generator; what is measured here is the *voice*:
 * that the buffer reaches the output, follows the envelope, survives the transport, and that the
 * two things the graph rather than the generator decides — `voice_mono` and rebuilding on an edit
 * to the field — do what the reference's arithmetic says.
 */
describe('water voices (types 5 and 6, §3.3)', () => {
  /** The reference's own defaults for each type (`main.c:3788`). */
  const DROPS = { baseFreq: 0.000352858, beatFreq: 2 };
  const RAIN = { baseFreq: 0.1, beatFreq: 8 };

  function water(entries: Entry[], overrides: Partial<Voice> = {}): Voice {
    return makeVoice(entries, { type: VoiceType.WaterDrops, ...overrides });
  }

  async function render(schedule: Schedule, seconds = 2): Promise<AudioBuffer> {
    const context = new OfflineAudioContext(2, seconds * SAMPLE_RATE, SAMPLE_RATE);
    playSchedule(context, schedule);
    return context.startRendering();
  }

  function rms(samples: Float32Array): number {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  it('sounds, for both types', async () => {
    const drops = await render(makeSchedule([water([makeEntry({ duration: 2, ...DROPS })])]));
    const rain = await render(
      makeSchedule([water([makeEntry({ duration: 2, ...RAIN })], { type: VoiceType.Rain })]),
    );

    expect(peakAmplitude(drops.getChannelData(0))).toBeGreaterThan(0.05);
    expect(peakAmplitude(rain.getChannelData(0))).toBeGreaterThan(0.05);
    // One field, panned across the two channels — not the independent streams noise uses.
    expect(Array.from(drops.getChannelData(0).subarray(0, 200))).not.toEqual(
      Array.from(drops.getChannelData(1).subarray(0, 200)),
    );
  });

  /** A `basefreq` of 0 is silence, not the raindrop default `main.c:617` promises in prose: the
   *  threshold *is* `basefreq`, so no slot ever seeds. */
  it('is silent at a basefreq of zero', async () => {
    const buffer = await render(
      makeSchedule([water([makeEntry({ duration: 2, baseFreq: 0, beatFreq: 8 })])]),
    );

    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });

  it('follows its volume envelope like any other voice', async () => {
    const buffer = await render(
      makeSchedule([
        water([
          makeEntry({ duration: 1, ...RAIN, volumeLeft: 1, volumeRight: 1 }),
          makeEntry({ duration: 1, ...RAIN, volumeLeft: 0, volumeRight: 0 }),
        ], { type: VoiceType.Rain }),
      ]),
    );
    const left = buffer.getChannelData(0);

    const head = rms(left.subarray(0, Math.round(0.1 * SAMPLE_RATE)));
    const tail = rms(left.subarray(Math.round(0.9 * SAMPLE_RATE), Math.round(SAMPLE_RATE)));
    expect(tail).toBeLessThan(head * 0.3);
  });

  it('keeps sounding across transport transitions, though buffer sources are single-use', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeSchedule([water([makeEntry({ duration: 30, ...RAIN })], { type: VoiceType.Rain })]));

    engine.play();
    engine.pause();
    engine.play();
    engine.seek(12);

    const buffer = await context.startRendering();
    expect(peakAmplitude(buffer.getChannelData(0).subarray(Math.round(0.2 * SAMPLE_RATE)))).toBeGreaterThan(0.2);
  });

  /**
   * `voice_mono` is not free here, unlike on a type-3 voice. `BB_Water` mixes each drop into both
   * channels *whole* when it is set (`:1201`), and the shared downmix then computes `(S + S) * 0.5`
   * (`:835`) — so the voice comes out centred and up to twice as loud per channel. Both source
   * nodes still have to exist for that sum to happen at all: one output connected to one input
   * twice is a no-op, which is what step 10 found on the isochronic pair.
   */
  it('centres a mono water voice and leaves it louder, not quieter', async () => {
    const entries = [makeEntry({ duration: 2, ...RAIN, volumeLeft: 0.4, volumeRight: 0.4 })];

    const stereo = await render(makeSchedule([water(entries, { type: VoiceType.Rain })]));
    const mono = await render(makeSchedule([water(entries, { type: VoiceType.Rain, mono: true })]));

    for (let i = 0; i < mono.length; i += 997) {
      expect(mono.getChannelData(1)[i]).toBeCloseTo(mono.getChannelData(0)[i], 6);
    }
    expect(rms(mono.getChannelData(0))).toBeGreaterThan(rms(stereo.getChannelData(0)) * 1.5);
  });

  /**
   * The field is baked into the buffer when the voice is built, so an edit to `entry[0]` is the one
   * kind of value change no automation can carry. `requiresVoiceRebuild` fires on it — otherwise the
   * edit is silently ignored until the document is reloaded — and the rebuild crossfades like any
   * other, so the change is audible without a hole in the middle of it.
   */
  it('rebuilds and crossfades when the density is edited mid-playback', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const sparse = makeSchedule([
      water([makeEntry({ duration: 30, baseFreq: 0.0002, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5 })]),
    ]);
    engine.load(sparse);
    engine.play();

    const buffer = await renderWithEditAt(context, 0.4, () =>
      engine.update(
        makeSchedule([
          water([makeEntry({ duration: 30, baseFreq: 0.05, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5 })]),
        ]),
      ),
    );
    const left = buffer.getChannelData(0);

    // Denser after the edit than before it, which only happens if the buffer was rebuilt.
    const before = rms(left.subarray(Math.round(0.1 * SAMPLE_RATE), Math.round(0.35 * SAMPLE_RATE)));
    const after = rms(left.subarray(Math.round(0.6 * SAMPLE_RATE)));
    expect(after).toBeGreaterThan(before * 3);
    // And nothing goes silent across the swap: the crossfade covers it.
    expect(peakAmplitude(left.subarray(Math.round(0.4 * SAMPLE_RATE), Math.round(0.6 * SAMPLE_RATE)))).toBeGreaterThan(0);
  });
});

/** A voice whose frequency ramps continuously for its whole 20s (never flat), so any offset
 *  within it has a distinct, unambiguous expected frequency — good for verifying transport. */
function makeRampingSchedule(): { schedule: Schedule; events: ReturnType<typeof compileVoice> } {
  const voice = makeVoice([
    makeEntry({ duration: 10, baseFreq: 300, beatFreq: 10 }), // left=305 @ t=0
    makeEntry({ duration: 10, baseFreq: 400, beatFreq: 10 }), // left=405 @ t=10, wraps to 305 @ t=20
  ]);
  return { schedule: makeSchedule([voice]), events: compileVoice(voice) };
}

describe('PlaybackEngine transport', () => {
  it('starts at offset 0 and pause() freezes state without throwing', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeRampingSchedule().schedule);

    expect(engine.getCurrentOffset()).toBe(0);
    expect(engine.isPlaying()).toBe(false);

    engine.play();
    expect(engine.isPlaying()).toBe(true);

    engine.pause();
    expect(engine.isPlaying()).toBe(false);
  });

  it('resumes from the paused offset, not from 0', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeRampingSchedule().schedule);

    engine.play();
    engine.seek(7.5);
    engine.pause();
    // Tolerance absorbs the ~CLICK_FREE_RAMP bookkeeping lag from chaining transport calls with
    // zero simulated real time between them (an artifact of synchronous test calls, not of
    // normal usage — see PROGRESS.md).
    expect(engine.getCurrentOffset()).toBeGreaterThan(7.4);
    expect(engine.getCurrentOffset()).toBeLessThanOrEqual(7.5);

    engine.play();
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getCurrentOffset()).toBeGreaterThan(7.4);
  });

  it('stop() resets to offset 0 and silences playback', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeRampingSchedule().schedule);

    engine.play();
    engine.seek(7.5);
    engine.stop();

    expect(engine.getCurrentOffset()).toBe(0);
    expect(engine.isPlaying()).toBe(false);
  });

  it('seeking mid-playback reproduces the correct curve value at the target offset (§8)', async () => {
    const { schedule, events } = makeRampingSchedule();
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE); // 1 second render
    const engine = new PlaybackEngine(context);
    engine.load(schedule);
    engine.play();
    engine.seek(5.0); // jump to schedule-time 5s while playing

    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);

    // Measure a short window safely after the anti-click fade settles.
    const measureStart = 0.1;
    const measureEnd = 0.3;
    const window = left.subarray(Math.round(measureStart * SAMPLE_RATE), Math.round(measureEnd * SAMPLE_RATE));
    const measuredFreq = estimateFrequency(window, SAMPLE_RATE);

    // Context-time `CLICK_FREE_RAMP` is schedule-time 5.0 (the fade's completion point), so the
    // window's midpoint maps to schedule-time 5.0 + midpoint - CLICK_FREE_RAMP.
    const scheduleMidpoint = 5.0 + (measureStart + measureEnd) / 2 - CLICK_FREE_RAMP;
    const expectedFreq = valueAtTime(events, scheduleMidpoint).leftFreq;

    expect(Math.abs(measuredFreq - expectedFreq)).toBeLessThan(2);
  });

  it('pausing then playing ends with silence briefly, and audible sound resumes after the fade', async () => {
    const { schedule } = makeRampingSchedule();
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE); // 1 second render
    const engine = new PlaybackEngine(context);
    engine.load(schedule);
    engine.play();
    engine.pause(); // ramps gain to 0 over CLICK_FREE_RAMP, then holds silent

    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);
    const tail = left.subarray(Math.round(0.5 * SAMPLE_RATE));

    expect(peakAmplitude(tail)).toBe(0);
  });
});

describe('channel and voice routing', () => {
  it('swaps the output channels after master volume is applied (§3.2)', async () => {
    // Asymmetric master volumes make the swap observable: the left master gain must follow the
    // audio into the *right* output, which a naive L/R swap of the sources would not do.
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 0 })])], {
      masterVolume: { left: 0.5, right: 1 },
      stereoSwap: true,
    });

    playSchedule(context, schedule);
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBeCloseTo(1, 1);
    expect(peakAmplitude(buffer.getChannelData(1))).toBeCloseTo(0.5, 1);
  });

  it('downmixes a mono voice to (L+R)/2 before applying per-channel volume (§3.2)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 40, volumeLeft: 1, volumeRight: 0.5 })], {
        mono: true,
      }),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    // Both channels carry the same summed signal, scaled only by their own volume — so right is
    // exactly half of left, sample for sample. A pan would instead leave two different pitches.
    for (let i = 0; i < left.length; i += 997) {
      expect(right[i]).toBeCloseTo(left[i] * 0.5, 5);
    }
    // The downmix of two tones 40 Hz apart beats acoustically, so it is not a constant-amplitude
    // sine: the summed peak stays at or below the 1.0 the two halves can reach together.
    expect(peakAmplitude(left)).toBeLessThanOrEqual(1.01);
  });

  it("honours the document's voice_mute flag when rendering offline", async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 2, baseFreq: 300, beatFreq: 0 })], { muted: true }),
    ]);

    playSchedule(context, schedule);
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });
});

describe('PlaybackEngine mixing', () => {
  function twoVoiceSchedule(): Schedule {
    return makeSchedule([
      makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })]),
      makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })], { id: 1 }),
    ]);
  }

  async function renderPeak(setup: (engine: PlaybackEngine) => void): Promise<number> {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(twoVoiceSchedule());
    engine.play();
    setup(engine);

    const buffer = await context.startRendering();
    // Skip the anti-click fade at the head of the render.
    return peakAmplitude(buffer.getChannelData(0).subarray(Math.round(0.2 * SAMPLE_RATE)));
  }

  it('silences a muted voice while the other keeps playing', async () => {
    const both = await renderPeak(() => {});
    const one = await renderPeak((engine) => engine.setVoiceMuted(0, true));

    expect(both).toBeGreaterThan(1.5);
    expect(one).toBeGreaterThan(0.5);
    expect(one).toBeLessThan(both * 0.75);
  });

  it('solo silences every voice that is not soloed', async () => {
    const soloed = await renderPeak((engine) => engine.setVoiceSoloed(1, true));
    expect(soloed).toBeGreaterThan(0.5);
    expect(soloed).toBeLessThan(1.5);
  });

  it('seeds mute state from the document but keeps runtime changes separate from it', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: 30, baseFreq: 300 })], { muted: true }),
      makeVoice([makeEntry({ duration: 30, baseFreq: 300 })], { id: 1 }),
    ]);
    engine.load(schedule);

    expect(engine.isVoiceMuted(0)).toBe(true);
    expect(engine.isVoiceAudible(0)).toBe(false);

    engine.setVoiceMuted(0, false);
    expect(engine.isVoiceAudible(0)).toBe(true);
    // Unmuting is session state; the document is untouched.
    expect(schedule.voices[0].muted).toBe(true);
  });

  function threeVoiceEngine(): PlaybackEngine {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(
      makeSchedule([0, 1, 2].map((id) => makeVoice([makeEntry({ duration: 30 })], { id }))),
    );
    return engine;
  }

  it('solos by muting the others, and un-solos by putting back the mutes it found', () => {
    const engine = threeVoiceEngine();
    engine.setVoiceMuted(2, true);

    engine.setVoiceSoloed(0, true);
    expect([0, 1, 2].map((i) => engine.isVoiceAudible(i))).toEqual([true, false, false]);
    expect(engine.isVoiceSoloed(0)).toBe(true);

    engine.setVoiceSoloed(0, false);
    // Voice 1 comes back; voice 2 was muted before the solo and stays that way.
    expect([0, 1, 2].map((i) => engine.isVoiceAudible(i))).toEqual([true, true, false]);
  });

  /** The whole point of deriving it: solo cannot go on claiming to be true once it is not. */
  it('stops reporting a solo as soon as another voice is un-muted by hand', () => {
    const engine = threeVoiceEngine();
    engine.setVoiceSoloed(0, true);

    engine.setVoiceMuted(1, false);
    expect(engine.isVoiceSoloed(0)).toBe(false);
    expect([0, 1, 2].map((i) => engine.isVoiceAudible(i))).toEqual([true, true, false]);
  });

  it('moves the solo rather than adding a second one', () => {
    const engine = threeVoiceEngine();
    engine.setVoiceSoloed(0, true);
    engine.setVoiceSoloed(2, true);

    expect([0, 1, 2].map((i) => engine.isVoiceSoloed(i))).toEqual([false, false, true]);
    expect([0, 1, 2].map((i) => engine.isVoiceAudible(i))).toEqual([false, false, true]);
  });

  /** Muting the soloed voice leaves nothing sounding, which is nobody's solo. */
  it('reports no solo when the soloed voice is itself muted', () => {
    const engine = threeVoiceEngine();
    engine.setVoiceSoloed(1, true);
    engine.setVoiceMuted(1, true);

    expect([0, 1, 2].map((i) => engine.isVoiceSoloed(i))).toEqual([false, false, false]);
  });

  /**
   * A voice this app cannot render (§3.3) has its controls disabled, so it can never be un-muted.
   * Counting it would make solo underivable on every programme that contains one.
   */
  it('derives solo over renderable voices only', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(
      makeSchedule([
        makeVoice([makeEntry({ duration: 30 })]),
        makeVoice([makeEntry({ duration: 30 })], { id: 1 }),
        makeVoice([makeEntry({ duration: 30 })], { id: 2, type: VoiceType.Pcm }),
      ]),
    );

    engine.setVoiceSoloed(0, true);
    expect(engine.isVoiceSoloed(0)).toBe(true);
    // Silencing it would be pointless; it never sounds either way.
    expect(engine.isVoiceMuted(2)).toBe(false);
  });

  it('scales output by the app master gain, independently of the file volumes', async () => {
    const full = await renderPeak(() => {});
    const half = await renderPeak((engine) => engine.setMasterGain(0.5));

    expect(half).toBeCloseTo(full * 0.5, 1);
  });
});

/**
 * A context that claims a real device's render-ahead buffer.
 *
 * `OfflineAudioContext` reports no `baseLatency`, which is how the engine knows there is nothing
 * in flight ahead of `currentTime`. Declaring one turns on the same scheduling lookahead a browser
 * gets, so it can be asserted on without a browser.
 */
function withBaseLatency(context: OfflineAudioContext, baseLatency: number): OfflineAudioContext {
  Object.defineProperty(context, 'baseLatency', { value: baseLatency, configurable: true });
  return context;
}

/** Where the rendered signal first becomes audible, in seconds. */
function onsetTime(samples: Float32Array, sampleRate: number, threshold = 0.02): number {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) return i / sampleRate;
  }
  return Infinity;
}

describe('scheduling lookahead on a real-time context', () => {
  async function renderStart(baseLatency: number): Promise<Float32Array> {
    const context = withBaseLatency(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE), baseLatency);
    const engine = new PlaybackEngine(context);
    engine.load(makeSchedule([makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })])]));
    engine.play();

    return (await context.startRendering()).getChannelData(0);
  }

  it('holds the fade until the audio thread can still see it, rather than ramping into the past', async () => {
    // Roughly desktop Chrome: tiny buffer, so the 50 ms floor is what applies.
    const left = await renderStart(0.0026);

    // Silent across the lookahead window, then a ramp — not an instant step, which is the click.
    expect(peakAmplitude(left.subarray(0, Math.round(0.045 * SAMPLE_RATE)))).toBe(0);
    expect(onsetTime(left, SAMPLE_RATE)).toBeGreaterThan(0.045);
    expect(onsetTime(left, SAMPLE_RATE)).toBeLessThan(0.075);
    expect(peakAmplitude(left.subarray(Math.round(0.08 * SAMPLE_RATE)))).toBeGreaterThan(0.9);
  });

  it('scales past the floor for a device that buffers as much as Android does', async () => {
    // 40 ms of buffering: the floor is not enough, so the lookahead has to grow with it.
    const left = await renderStart(0.04);

    expect(peakAmplitude(left.subarray(0, Math.round(0.11 * SAMPLE_RATE)))).toBe(0);
    expect(onsetTime(left, SAMPLE_RATE)).toBeGreaterThan(0.11);
  });

  it('adds no lookahead offline, so an export is not padded with silence', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeSchedule([makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })])]));
    engine.play();

    const left = (await context.startRendering()).getChannelData(0);
    // Audible as soon as the fade itself is done — nowhere near the 50 ms floor a real-time
    // context would have inserted first.
    expect(onsetTime(left, SAMPLE_RATE)).toBeLessThan(CLICK_FREE_RAMP * 1.5);
  });
});

describe('end of schedule (§3.7)', () => {
  it('reports the shortest voice as the duration, counting voices it cannot render', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(
      makeSchedule([
        makeVoice([makeEntry({ duration: 30, baseFreq: 300 })]),
        makeVoice([makeEntry({ duration: 12, baseFreq: 300 })], { id: 1, type: VoiceType.PinkNoise }),
      ]),
    );

    expect(engine.getDuration()).toBe(12);
  });

  it('goes silent at the end instead of holding the last value forever', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    // Ends a third of the way into a one-second render.
    engine.load(makeSchedule([makeVoice([makeEntry({ duration: 0.33, baseFreq: 300, beatFreq: 0 })])]));
    engine.play();

    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0);

    expect(peakAmplitude(left.subarray(Math.round(0.1 * SAMPLE_RATE), Math.round(0.3 * SAMPLE_RATE)))).toBeGreaterThan(0.5);
    expect(peakAmplitude(left.subarray(Math.round(0.6 * SAMPLE_RATE)))).toBe(0);
  });

  it('clamps the reported offset and refuses to seek past the end', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(makeRampingSchedule().schedule);

    engine.seek(999);
    expect(engine.getCurrentOffset()).toBe(20);
  });
});

/** Largest sample-to-sample step in a window — a step, rather than a glide, is what clicks. */
function maxStep(samples: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i] - samples[i - 1]));
  return worst;
}

describe('loops (§3.2)', () => {
  /** One pass: full volume for 0.2 s, fading to silence by 0.4 s, then §3.5's wrap back to full. */
  const PASS = 0.4;
  function loopingSchedule(loops: number, extraVoices: Voice[] = []): Schedule {
    const voice = makeVoice([
      makeEntry({ duration: 0.2, baseFreq: 400, beatFreq: 0, volumeLeft: 1, volumeRight: 1 }),
      makeEntry({ duration: 0.2, baseFreq: 400, beatFreq: 0, volumeLeft: 0, volumeRight: 0 }),
    ]);
    return makeSchedule([voice, ...extraVoices], { loops });
  }

  it('plays once by default, and a single pass is all the engine reports', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(loopingSchedule(1));

    expect(engine.getPassCount()).toBe(1);
    expect(engine.getTotalDuration()).toBe(engine.getDuration());
  });

  it('replays the whole schedule `loops` times, then stops', async () => {
    const context = new OfflineAudioContext(2, Math.round(1.2 * SAMPLE_RATE), SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(loopingSchedule(2));
    engine.play();

    const left = (await context.startRendering()).getChannelData(0);
    // Offline contexts get no lookahead, so schedule-time zero is CLICK_FREE_RAMP into the render.
    const at = (t: number) => Math.round((CLICK_FREE_RAMP + t) * SAMPLE_RATE);

    // The envelope repeats: loud at the top of each pass, silent at the end of each.
    expect(peakAmplitude(left.subarray(at(0.02), at(0.08)))).toBeGreaterThan(0.5);
    expect(peakAmplitude(left.subarray(at(0.18), at(0.2)))).toBeLessThan(0.1);
    expect(peakAmplitude(left.subarray(at(0.42), at(0.48)))).toBeGreaterThan(0.5);
    expect(peakAmplitude(left.subarray(at(0.58), at(0.6)))).toBeLessThan(0.1);

    // And then it is over, rather than running on for a third pass.
    expect(peakAmplitude(left.subarray(at(2 * PASS + CLICK_FREE_RAMP)))).toBe(0);
    expect(engine.getPass()).toBe(1);
    expect(engine.hasEnded()).toBe(true);
  });

  it('joins one pass to the next without a discontinuity', async () => {
    const context = new OfflineAudioContext(2, Math.round(1.2 * SAMPLE_RATE), SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    // Frequency and volume both move, so the seam has something to get wrong. §3.5's unconditional
    // wrap is what makes it continuous: the last segment already glides back to entry[0].
    engine.load(
      makeSchedule(
        [
          makeVoice([
            makeEntry({ duration: 0.2, baseFreq: 200, beatFreq: 0, volumeLeft: 0.3, volumeRight: 0.3 }),
            makeEntry({ duration: 0.2, baseFreq: 400, beatFreq: 0, volumeLeft: 1, volumeRight: 1 }),
          ]),
        ],
        { loops: 3 },
      ),
    );
    engine.play();

    const left = (await context.startRendering()).getChannelData(0);
    const around = (t: number) =>
      left.subarray(
        Math.round((CLICK_FREE_RAMP + t - 0.01) * SAMPLE_RATE),
        Math.round((CLICK_FREE_RAMP + t + 0.01) * SAMPLE_RATE),
      );

    // A 400 Hz sine at 44.1 kHz steps by at most ~0.057 between samples; a seam that snapped
    // volume from 1.0 back to 0.3 would step by an order of magnitude more.
    expect(maxStep(around(PASS))).toBeLessThan(0.1);
    expect(maxStep(around(2 * PASS))).toBeLessThan(0.1);
  });

  it('ramps rather than snaps a voice that §3.7 cuts short at the seam', async () => {
    const context = new OfflineAudioContext(2, Math.round(1.2 * SAMPLE_RATE), SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    // The second voice outlasts the schedule, so a loop restarts it partway up its own volume
    // curve — the one seam that is genuinely discontinuous in Gnaural.
    engine.load(
      loopingSchedule(2, [
        makeVoice([
          makeEntry({ duration: 0.6, baseFreq: 300, beatFreq: 0, volumeLeft: 0, volumeRight: 0 }),
          makeEntry({ duration: 0.6, baseFreq: 300, beatFreq: 0, volumeLeft: 1, volumeRight: 1 }),
        ]),
      ]),
    );
    engine.play();

    const left = (await context.startRendering()).getChannelData(0);
    const seam = left.subarray(
      Math.round((CLICK_FREE_RAMP + PASS - 0.005) * SAMPLE_RATE),
      Math.round((CLICK_FREE_RAMP + PASS + 0.03) * SAMPLE_RATE),
    );

    expect(maxStep(seam)).toBeLessThan(0.1);
  });

  it('repeats endlessly for `loops` of zero or less, bounded so it can still be scheduled', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    const minutes = () => makeSchedule([makeVoice([makeEntry({ duration: 60, baseFreq: 300 })])], { loops: 0 });

    engine.load(minutes());
    expect(engine.getPassCount()).toBe(720); // 12 hours of one-minute passes
    expect(engine.getTotalDuration()).toBe(12 * 60 * 60);

    // Gnaural decrements to exactly zero, so anything below one loops forever too.
    engine.load({ ...minutes(), loops: -3 });
    expect(engine.getPassCount()).toBe(720);
  });

  it('caps the pass count for a schedule short enough that the horizon alone would not', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(makeSchedule([makeVoice([makeEntry({ duration: 1, baseFreq: 300 })])], { loops: 0 }));

    expect(engine.getPassCount()).toBe(1000);
  });

  it('seeks within the current pass rather than back to the first', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(loopingSchedule(4));

    engine.seek(0.3);
    expect(engine.getCurrentOffset()).toBeCloseTo(0.3);
    expect(engine.getPass()).toBe(0);
  });

  it('treats the end of a pass as the start of the next, because that is one instant', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(loopingSchedule(4));

    engine.seek(999); // clamped to the end of pass 1, which is where pass 2 begins
    expect(engine.getPass()).toBe(1);
    expect(engine.getCurrentOffset()).toBe(0);
    expect(engine.hasEnded()).toBe(false);

    // Only the end of the *final* pass is the end of playback.
    engine.seek(999);
    engine.seek(999);
    engine.seek(999);
    expect(engine.getPass()).toBe(3);
    expect(engine.getCurrentOffset()).toBe(PASS);
    expect(engine.hasEnded()).toBe(true);
  });
});

/** A real-time-looking context the platform has suspended, as Android does on a media-session pause. */
function suspended(context: OfflineAudioContext): { context: OfflineAudioContext; resume: ReturnType<typeof vi.fn> } {
  const resume = vi.fn().mockResolvedValue(undefined);
  withBaseLatency(context, 0.01);
  Object.defineProperty(context, 'state', { get: () => 'suspended', configurable: true });
  Object.defineProperty(context, 'resume', { value: resume, configurable: true });
  return { context, resume };
}

describe('a context the platform suspended', () => {
  const schedule = () =>
    makeSchedule([makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })])]);

  it('is resumed on play, so a lock-screen pause is not the end of the session', () => {
    // Found on hardware: pause from the notification took audio focus away, Chrome suspended the
    // context, and nothing — not the notification, not the in-app button — could start it again.
    const { context, resume } = suspended(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    const engine = new PlaybackEngine(context);
    engine.load(schedule());

    engine.play();
    expect(resume).toHaveBeenCalled();
  });

  it('is resumed on a seek that resumes playback, since seek is the same primitive', () => {
    const { context, resume } = suspended(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    const engine = new PlaybackEngine(context);
    engine.load(schedule());
    engine.play();
    resume.mockClear();

    engine.seek(10);
    expect(resume).toHaveBeenCalled();
  });

  it('is left alone when stopping or pausing — those want it quiet, not running', () => {
    const { context, resume } = suspended(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    const engine = new PlaybackEngine(context);
    engine.load(schedule());
    engine.play();
    resume.mockClear();

    engine.stop();
    expect(resume).not.toHaveBeenCalled();
  });

  it('never resumes an offline context, which reports suspended until it renders', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const resume = vi.fn();
    Object.defineProperty(context, 'resume', { value: resume, configurable: true });

    const engine = new PlaybackEngine(context);
    engine.load(schedule());
    engine.play();

    expect(resume).not.toHaveBeenCalled();
    // And the render still produces sound, rather than having been started out from under it.
    expect(peakAmplitude((await context.startRendering()).getChannelData(0))).toBeGreaterThan(0.5);
  });
});

describe('prepare()', () => {
  const schedule = () =>
    makeSchedule([makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0 })])]);

  it('exposes the output rate before anything is scheduled', () => {
    // This is what lets the keepalive be started *before* the engine on Android, without losing
    // the real sample rate — the ordering that makes audio focus available to the resume.
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(schedule());

    engine.prepare();
    expect(engine.getSampleRate()).toBe(SAMPLE_RATE);
  });

  it('makes no sound on its own, and does not disturb the play that follows', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(schedule());

    engine.prepare();
    engine.prepare(); // idempotent
    engine.play();

    const left = (await context.startRendering()).getChannelData(0);
    expect(peakAmplitude(left.subarray(Math.round(0.1 * SAMPLE_RATE)))).toBeGreaterThan(0.5);
  });

  it('is silent if play never follows', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(schedule());

    engine.prepare();

    expect(peakAmplitude((await context.startRendering()).getChannelData(0))).toBe(0);
  });
});

/**
 * Run an edit partway through an offline render.
 *
 * `OfflineAudioContext.suspend()` stops the render at a quantum boundary and hands control back, so
 * an edit can be applied against a graph that is genuinely mid-flight — the same thing a drag does
 * during playback, at sample resolution and with no browser. This is what makes §6.1's live
 * re-scheduling assertable rather than merely reviewed.
 */
async function renderWithEditAt(
  context: OfflineAudioContext,
  when: number,
  edit: () => void,
): Promise<AudioBuffer> {
  const suspended = context.suspend(when).then(() => {
    edit();
    void context.resume();
  });

  // Yield once before starting the render. `suspend()` hands its request to the audio thread
  // asynchronously, and node-web-audio-api rejects it with `InvalidStateError` if the render has
  // already run past the point — which, issued back to back, it does a few percent of the time.
  // Measured in this container: 2 rejections in 60 without this line, 0 in 120 with it.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Awaited together so a rejected suspend fails the test outright. Left unhandled it would render
  // without ever applying the edit, and the failure would surface as a baffling assertion about
  // frequency somewhere else entirely.
  const [buffer] = await Promise.all([context.startRendering(), suspended]);
  return buffer;
}

/** A steady tone, so a frequency measured after an edit is unambiguous. */
function steadySchedule(baseFreq: number, volume = 1, voices = 1): Schedule {
  return makeSchedule(
    Array.from({ length: voices }, (_unused, id) =>
      makeVoice([makeEntry({ duration: 30, baseFreq, beatFreq: 0, volumeLeft: volume, volumeRight: volume })], { id }),
    ),
  );
}

describe('update() — live re-scheduling (§6.1)', () => {
  const EDIT_AT = 0.5;

  function windowOf(samples: Float32Array, from: number, to: number): Float32Array {
    return samples.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
  }

  it('is heard from the edit onwards, and not before it', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(steadySchedule(500)),
    );
    const left = buffer.getChannelData(0);

    // Zero-crossing counting resolves to 1/window, so ~3.3 Hz over these 0.3 s windows.
    expect(Math.abs(estimateFrequency(windowOf(left, 0.1, 0.4), SAMPLE_RATE) - 300)).toBeLessThan(5);
    expect(Math.abs(estimateFrequency(windowOf(left, 0.6, 0.9), SAMPLE_RATE) - 500)).toBeLessThan(5);
  });

  it('does not click at the edit, because the oscillator keeps its phase', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(steadySchedule(500)),
    );

    // A phase-continuous 500 Hz sine steps ~0.07 per sample at this rate; a restarted oscillator or
    // a stepped gain would jump far further.
    expect(maxStep(windowOf(buffer.getChannelData(0), 0.45, 0.55))).toBeLessThan(0.2);
  });

  it('keeps playing rather than starting over — the graph is not rebuilt', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(steadySchedule(500)),
    );

    // `load()` would have faded to silence and faded back in. Nothing here dips at all.
    expect(peakAmplitude(windowOf(buffer.getChannelData(0), 0.45, 0.6))).toBeGreaterThan(0.9);
  });

  it('does not walk the playhead backwards, however many edits arrive', () => {
    // The failure this pins: `rescheduleFrom` lands `lookahead + CLICK_FREE_RAMP` in the future, so
    // rescheduling *at* the current offset silently rewinds by that much. Once per seek it is
    // invisible; ten times a second under a drag it stalls the playhead outright.
    const context = withBaseLatency(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE), 0.04);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300));
    engine.play();
    engine.seek(5);

    const before = engine.getCurrentOffset();
    for (let i = 0; i < 20; i++) engine.update(steadySchedule(300 + i));

    expect(engine.getCurrentOffset()).toBeCloseTo(before, 6);
  });

  it('crossfades rather than cuts when an edit removes a voice', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300, 0.5, 2));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(steadySchedule(300, 0.5, 1)),
    );
    const left = buffer.getChannelData(0);

    expect(peakAmplitude(windowOf(left, 0.1, 0.4))).toBeGreaterThan(0.7);
    expect(peakAmplitude(windowOf(left, 0.6, 0.9))).toBeCloseTo(0.5, 1);
    // Retiring a voice ramps it out over CLICK_FREE_RAMP; releasing it outright would step.
    expect(maxStep(windowOf(left, 0.45, 0.6))).toBeLessThan(0.2);
  });

  it('applies an edit to stereoswap without rewiring the graph (§3.2)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const asymmetric = { masterVolume: { left: 0.5, right: 1 }, stereoSwap: false };
    engine.load(makeSchedule(steadySchedule(300).voices, asymmetric));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(makeSchedule(steadySchedule(300).voices, { ...asymmetric, stereoSwap: true })),
    );

    expect(peakAmplitude(windowOf(buffer.getChannelData(0), 0.1, 0.4))).toBeCloseTo(0.5, 1);
    expect(peakAmplitude(windowOf(buffer.getChannelData(0), 0.6, 0.9))).toBeCloseTo(1, 1);
  });

  it('leaves session mute and solo alone, but takes on a mute the edit actually changed', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300, 1, 2));
    engine.play();

    engine.setVoiceSoloed(1, true);
    engine.update(steadySchedule(400, 1, 2));
    expect(engine.isVoiceSoloed(1)).toBe(true);

    const muted = steadySchedule(400, 1, 2);
    muted.voices[0] = { ...muted.voices[0], muted: true };
    engine.update(muted);
    expect(engine.isVoiceMuted(0)).toBe(true);

    // A listener's own un-mute must survive every later edit that does not touch the flag.
    engine.setVoiceMuted(0, false);
    engine.update(steadySchedule(410, 1, 2));
    expect(engine.isVoiceMuted(0)).toBe(false);
  });

  /**
   * The other half of the crossfade, and the one a real caller only got in step 6: adding a voice.
   * A different frequency rather than a second copy of the same one, so the two sum to a level that
   * does not depend on their relative phase.
   */
  it('crossfades a new voice in when an edit adds one', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const first = makeVoice([makeEntry({ duration: 30, baseFreq: 300, beatFreq: 0, volumeLeft: 0.5, volumeRight: 0.5 })]);
    const second = makeVoice(
      [makeEntry({ duration: 30, baseFreq: 700, beatFreq: 0, volumeLeft: 0.5, volumeRight: 0.5 })],
      { id: 1 },
    );

    engine.load(makeSchedule([first]));
    engine.play();

    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(makeSchedule([first, second]), 'full', [0]),
    );
    const left = buffer.getChannelData(0);

    expect(peakAmplitude(windowOf(left, 0.1, 0.4))).toBeCloseTo(0.5, 1);
    expect(peakAmplitude(windowOf(left, 0.6, 0.9))).toBeGreaterThan(0.85);
    // Built silent and ramped in over CLICK_FREE_RAMP; appearing at full level would step.
    expect(maxStep(windowOf(left, 0.45, 0.6))).toBeLessThan(0.2);
  });

  /**
   * Session gates are keyed by index into `schedule.voices` (§3.4 — ids are not unique), so a
   * structural edit has to say what moved or the gates stay on slots that now hold other voices.
   */
  it('carries session gates across a reorder, given the voice map', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const before = steadySchedule(300, 1, 3);
    engine.load(before);
    engine.play();
    engine.setVoiceSoloed(2, true);

    const edit = moveVoice(before, { from: 2, to: 0 });
    engine.update(edit.schedule, 'full', edit.voiceMap);

    expect(engine.isVoiceSoloed(0)).toBe(true);
    expect(engine.isVoiceSoloed(2)).toBe(false);
    expect(engine.isVoiceAudible(0)).toBe(true);
    expect(engine.isVoiceAudible(1)).toBe(false);
  });

  /**
   * The failure the map exists to prevent, asserted from the other side so it cannot be dropped.
   *
   * On the mute indices rather than on `isVoiceSoloed`, which is derived from them: the voice that
   * moved to slot 0 is the one that should still be heard, and without the map slot 2 is.
   */
  it('leaves a gate on the wrong voice when a reorder arrives without its map', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const before = steadySchedule(300, 1, 3);
    engine.load(before);
    engine.play();
    engine.setVoiceSoloed(2, true);

    engine.update(moveVoice(before, { from: 2, to: 0 }).schedule);

    expect([0, 1, 2].map((i) => engine.isVoiceMuted(i))).toEqual([true, true, false]);
  });

  it('closes the gap in the gates when a voice is deleted', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const before = steadySchedule(300, 1, 3);
    engine.load(before);
    engine.play();
    engine.setVoiceMuted(2, true);

    const edit = removeVoice(before, 0);
    engine.update(edit.schedule, 'full', edit.voiceMap);

    expect(engine.isVoiceMuted(1)).toBe(true);
    expect(engine.isVoiceMuted(2)).toBe(false);
  });

  /**
   * A reorder compares every voice against a different one, so without the map the document's own
   * mute flags read as flags the edit changed. Here neither voice's flag moved relative to itself.
   */
  it('does not adopt a document mute that only appears to have changed', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const before = steadySchedule(300, 1, 3);
    before.voices[0] = { ...before.voices[0], muted: true };
    engine.load(before);
    engine.play();
    // A listener overrides the document: they want to hear voice 0 after all.
    engine.setVoiceMuted(0, false);

    const edit = moveVoice(before, { from: 0, to: 2 });
    engine.update(edit.schedule, 'full', edit.voiceMap);

    expect(engine.isVoiceMuted(2)).toBe(false);
    expect(engine.isVoiceMuted(0)).toBe(false);
  });

  /** Deleting the last voice is an allowed state (9a already warns for it), not a crash. */
  it('goes silent without throwing when an edit leaves no voices at all', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    const before = steadySchedule(300, 1, 1);
    engine.load(before);
    engine.play();

    const edit = removeVoice(before, 0);
    const buffer = await renderWithEditAt(context, EDIT_AT, () =>
      engine.update(edit.schedule, 'full', edit.voiceMap),
    );

    expect(engine.getDuration()).toBe(0);
    expect(engine.getCurrentOffset()).toBe(0);
    expect(peakAmplitude(windowOf(buffer.getChannelData(0), 0.7, 0.95))).toBeLessThan(0.01);
  });

  it('stays paused, and where it was, when edited while paused', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeRampingSchedule().schedule);
    engine.play();
    engine.seek(7.5);
    engine.pause();

    const before = engine.getCurrentOffset();
    engine.update(makeRampingSchedule().schedule);

    expect(engine.isPlaying()).toBe(false);
    expect(engine.getCurrentOffset()).toBeCloseTo(before, 6);
  });

  it('ends the schedule where an edit that shortens it puts the end (§3.7)', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(steadySchedule(300));
    engine.play();
    engine.seek(20);

    engine.update(makeSchedule([makeVoice([makeEntry({ duration: 10, baseFreq: 300 })])]));

    expect(engine.getDuration()).toBe(10);
    // Clamped to the new end rather than left stranded at 20. The last CLICK_FREE_RAMP of it is the
    // same bookkeeping lag every transport call has, and resolves as real time advances.
    expect(engine.getCurrentOffset()).toBeGreaterThan(10 - CLICK_FREE_RAMP * 1.5);
    expect(engine.getCurrentOffset()).toBeLessThanOrEqual(10);
  });

  it('loads outright when nothing is loaded yet, so a first edit is not a special case', () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);

    engine.update(steadySchedule(300));

    expect(engine.getDuration()).toBe(30);
    expect(engine.getCurrentOffset()).toBe(0);
  });
});

/**
 * The editing horizon (§6.1, PROGRESS's step 5).
 *
 * `rescheduleFrom` schedules every remaining pass up front, which is right for a transport action
 * and ruinous under a finger: a 60-second looping draft with 45 entries costs 132,480 param events
 * and 68 ms of main thread per call, ten times a second. No bundled programme can show this — all
 * 19 are `loops = 1`, so their horizon is one pass either way — which is exactly why it is pinned
 * here against a synthetic short loop.
 */
describe('the editing horizon', () => {
  /** Four passes of a half-second envelope: loud for the first half, silent for the second. */
  const PASS = 0.5;
  function shortLoop(): Schedule {
    return makeSchedule(
      [
        makeVoice([
          makeEntry({ duration: PASS / 2, baseFreq: 400, beatFreq: 0, volumeLeft: 1, volumeRight: 1 }),
          makeEntry({ duration: PASS / 2, baseFreq: 400, beatFreq: 0, volumeLeft: 0, volumeRight: 0 }),
        ]),
      ],
      { loops: 4 },
    );
  }

  /**
   * The edit is applied before the render rather than suspended into the middle of one. What is
   * under test is how far `update()` schedules, and `rescheduleFrom` cancels and rewrites every
   * param either way — so the mid-render machinery would add nothing but its own documented
   * `suspend()` race, four more times.
   */
  async function renderHorizon(schedule: Schedule, horizon?: Horizon): Promise<Float32Array> {
    const context = new OfflineAudioContext(2, Math.round(2.2 * SAMPLE_RATE), SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(schedule);
    engine.play();
    engine.update(updateSchedule(schedule, { title: 'edited' }), horizon);

    return (await context.startRendering()).getChannelData(0);
  }

  // The update re-anchors schedule-time zero onto context-time zero exactly: it resumes at the
  // offset `play()` had reached plus the window it projects forward, and lays that same window back
  // down in front of it. Measured, not assumed — the troughs land at 0.25 s and 0.75 s.
  const at = (t: number) => Math.round(t * SAMPLE_RATE);

  /** The trough in the middle of a pass: §3.5's wrap takes the volume 1 -> 0 -> 1 across each one. */
  const trough = (pass: number) => [at(pass * PASS + 0.24), at(pass * PASS + 0.26)] as const;

  it('schedules every pass by default, so a committed edit is complete', async () => {
    const left = await renderHorizon(shortLoop());

    // The envelope is still dipping in the third and fourth passes.
    expect(peakAmplitude(left.subarray(...trough(2)))).toBeLessThan(0.1);
    expect(peakAmplitude(left.subarray(...trough(3)))).toBeLessThan(0.1);
    // And it ends where it should rather than running on.
    expect(peakAmplitude(left.subarray(at(4 * PASS + CLICK_FREE_RAMP)))).toBe(0);
  });

  it('stops at the current pass and the next when the caller asks for a gesture horizon', async () => {
    const left = await renderHorizon(shortLoop(), 'gesture');

    // Passes 0 and 1 carry their envelope, as always.
    expect(peakAmplitude(left.subarray(...trough(0)))).toBeLessThan(0.1);
    expect(peakAmplitude(left.subarray(...trough(1)))).toBeLessThan(0.1);
    // Past the horizon each param holds its last scheduled value, which §3.5's wrap put back at
    // entry[0]. So pass 2 drones at full level instead of dipping: audible and obviously wrong,
    // rather than silent and indistinguishable from a bug.
    expect(peakAmplitude(left.subarray(...trough(2)))).toBeGreaterThan(0.5);
  });

  /**
   * The failure mode the whole arrangement exists to make impossible. Scheduling the end-of-schedule
   * fade at a *truncated* horizon would silence a looping programme mid-drag, and it would look like
   * an engine bug rather than a forgotten expansion.
   */
  it('does not schedule the end-of-schedule fade at a truncated horizon', async () => {
    // A flat, always-audible pass, so anything silent after the horizon is the fade and nothing else.
    const flat = makeSchedule(
      [makeVoice([makeEntry({ duration: PASS, baseFreq: 400, beatFreq: 0, volumeLeft: 1, volumeRight: 1 })])],
      { loops: 4 },
    );
    const left = await renderHorizon(flat, 'gesture');

    expect(peakAmplitude(left.subarray(at(2 * PASS), at(2 * PASS + 0.2)))).toBeGreaterThan(0.5);
    expect(peakAmplitude(left.subarray(at(3 * PASS), at(3 * PASS + 0.2)))).toBeGreaterThan(0.5);
  });

  /** Every bundled programme takes this path, so the opt-in must cost them nothing. */
  it('is a no-op for a schedule that plays once', async () => {
    const once = makeSchedule(
      [makeVoice([makeEntry({ duration: 0.6, baseFreq: 400, beatFreq: 0, volumeLeft: 1, volumeRight: 1 })])],
      { loops: 1 },
    );
    const left = await renderHorizon(once, 'gesture');

    expect(peakAmplitude(left.subarray(at(0.3), at(0.55)))).toBeGreaterThan(0.5);
    // The fade still lands at the true end, because the horizon reached it.
    expect(peakAmplitude(left.subarray(at(0.6 + CLICK_FREE_RAMP)))).toBe(0);
  });
});

/** A schedule with a voice that consumes time and makes no sound, so whatever is rendered is the
 *  app's noise layer and nothing else. */
function silentSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return makeSchedule(
    [makeVoice([makeEntry({ duration: 30, baseFreq: 300, volumeLeft: 0, volumeRight: 0 })])],
    overrides,
  );
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

describe('the app-level noise layer (§4.5b)', () => {
  async function renderLayer(
    schedule: Schedule,
    settings: NoiseLayerSettings,
    prepare: (engine: PlaybackEngine) => void = () => undefined,
  ): Promise<AudioBuffer> {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(schedule);
    engine.setNoiseLayer(settings);
    prepare(engine);
    engine.play();
    return context.startRendering();
  }

  it('is silent by default — nothing turns it on but a person (§3.8 item 6)', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(silentSchedule());
    engine.play();
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
    expect(peakAmplitude(buffer.getChannelData(1))).toBe(0);
  });

  it('mixes a bed at the level a voice of the same volume would sit at', async () => {
    const buffer = await renderLayer(silentSchedule(), { colour: 'gnaural', gain: 0.5 });

    // NOISE_REFERENCE_RMS × 0.5, measured past the fade-in.
    const from = Math.round(0.2 * SAMPLE_RATE);
    expect(rms(buffer.getChannelData(0).subarray(from))).toBeCloseTo(0.145, 2);
    expect(rms(buffer.getChannelData(1).subarray(from))).toBeCloseTo(0.145, 2);
  });

  it('is decorrelated across the channels, like every other noise here (§4.5)', async () => {
    const buffer = await renderLayer(silentSchedule(), { colour: 'white', gain: 0.5 });

    expect(buffer.getChannelData(0).slice(0, 100)).not.toEqual(buffer.getChannelData(1).slice(0, 100));
  });

  it("ignores the document's own mixing — it is the app's layer, not the file's", async () => {
    // §4.5b puts it before the master gain, and the only master gain that is the app's to use is
    // its own: `overallvolume_*` and `stereoswap` describe how the *program* is mixed. A program
    // that is silent on the left and swapped still hears the same bed in both ears.
    const buffer = await renderLayer(
      silentSchedule({ masterVolume: { left: 0, right: 1 }, stereoSwap: true }),
      { colour: 'gnaural', gain: 0.5 },
    );

    const from = Math.round(0.2 * SAMPLE_RATE);
    expect(rms(buffer.getChannelData(0).subarray(from))).toBeCloseTo(0.145, 2);
    expect(rms(buffer.getChannelData(1).subarray(from))).toBeCloseTo(0.145, 2);
  });

  it("follows the app's own volume, which is what the slider is for", async () => {
    const buffer = await renderLayer(silentSchedule(), { colour: 'gnaural', gain: 0.5 }, (engine) =>
      engine.setMasterGain(0),
    );

    expect(peakAmplitude(buffer.getChannelData(0))).toBeLessThan(0.01);
  });

  it('stops with the transport — a bed with nothing under it is just hiss', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(silentSchedule());
    engine.setNoiseLayer({ colour: 'gnaural', gain: 0.5 });
    engine.play();

    const buffer = await renderWithEditAt(context, 0.5, () => engine.pause());
    const left = buffer.getChannelData(0);

    expect(rms(left.subarray(Math.round(0.2 * SAMPLE_RATE), Math.round(0.45 * SAMPLE_RATE)))).toBeGreaterThan(0.1);
    expect(peakAmplitude(left.subarray(Math.round(0.6 * SAMPLE_RATE)))).toBeLessThan(0.01);
  });

  it('ends where the schedule does, without waiting to be told', async () => {
    // Scheduled up front like everything else (§4.2): rAF is not running with the screen off, so
    // the app's own end-of-schedule stop cannot be what silences it.
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(makeSchedule([makeVoice([makeEntry({ duration: 0.5, volumeLeft: 0, volumeRight: 0 })])]));
    engine.setNoiseLayer({ colour: 'gnaural', gain: 0.5 });
    engine.play();
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0).subarray(Math.round(0.6 * SAMPLE_RATE)))).toBeLessThan(0.01);
  });

  it('crossfades a colour change rather than dropping out', async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(silentSchedule());
    engine.setNoiseLayer({ colour: 'gnaural', gain: 0.5 });
    engine.play();

    const buffer = await renderWithEditAt(context, 0.5, () =>
      engine.setNoiseLayer({ colour: 'white', gain: 0.5 }),
    );
    const left = buffer.getChannelData(0);

    // Level holds across the swap — the old sources fade out as the new ones fade in.
    const across = rms(left.subarray(Math.round(0.49 * SAMPLE_RATE), Math.round(0.53 * SAMPLE_RATE)));
    expect(across).toBeGreaterThan(0.1);
    expect(rms(left.subarray(Math.round(0.7 * SAMPLE_RATE)))).toBeCloseTo(0.145, 2);
  });

  it('is generated by prepare(), before anything is sounding, and stays silent there', async () => {
    // The setting persists, so "already on before Play" is the common case. Filling the buffers
    // inside the first `rescheduleFrom` would put tens of milliseconds between reading the clock
    // and scheduling against it — the anti-click ramp back in the past, which is the bug
    // `scheduleLookahead` exists for.
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new PlaybackEngine(context);
    engine.load(silentSchedule());
    engine.setNoiseLayer({ colour: 'gnaural', gain: 0.5 });
    engine.prepare();
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });

  it('is absent from the export path, which renders the document as authored', async () => {
    // `playSchedule` is what `renderSchedule` runs, and it shares `buildOutputChain` with the
    // engine — so this pins the layer to `PlaybackEngine` rather than to the shared chain, which
    // is also what keeps §5.3's null test comparing like with like.
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    playSchedule(context, silentSchedule());
    const buffer = await context.startRendering();

    expect(peakAmplitude(buffer.getChannelData(0))).toBe(0);
  });
});
