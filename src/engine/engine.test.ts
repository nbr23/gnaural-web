import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { compileVoice, valueAtTime } from './compiler';
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

  it('makes a soloed voice audible and everything else silent, mute aside', () => {
    const engine = new PlaybackEngine(new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE));
    engine.load(twoVoiceSchedule());

    engine.setVoiceSoloed(1, true);
    expect(engine.isVoiceAudible(0)).toBe(false);
    expect(engine.isVoiceAudible(1)).toBe(true);

    // A voice that is both soloed and muted stays silent.
    engine.setVoiceMuted(1, true);
    expect(engine.isVoiceAudible(1)).toBe(false);

    engine.setVoiceSoloed(1, false);
    expect(engine.isVoiceAudible(0)).toBe(true);
  });

  it('scales output by the app master gain, independently of the file volumes', async () => {
    const full = await renderPeak(() => {});
    const half = await renderPeak((engine) => engine.setMasterGain(0.5));

    expect(half).toBeCloseTo(full * 0.5, 1);
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
