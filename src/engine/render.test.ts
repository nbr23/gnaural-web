import { OfflineAudioContext } from 'node-web-audio-api';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { CLICK_FREE_RAMP, PlaybackEngine } from './engine';
import { RenderCancelledError, renderFrameCount, renderSchedule } from './render';
import { decodeWav, readBlob } from './test-wav';
import { encodeWav } from './wav';

const SAMPLE_RATE = 44100;

// `renderSchedule` constructs its own context, as it must in a browser; Node needs the global to
// exist first.
beforeAll(() => {
  globalThis.OfflineAudioContext = OfflineAudioContext as unknown as typeof globalThis.OfflineAudioContext;
});

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
    // The null test below compares one pass of live playback against the export, so the fixture
    // must not loop — `PlaybackEngine` repeats, `renderSchedule` deliberately does not.
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
    ...overrides,
  };
}

describe('renderSchedule', () => {
  it('renders the schedule plus the tail of its end-of-schedule fade', async () => {
    const schedule = makeSchedule([makeVoice([makeEntry({ duration: 0.5, baseFreq: 300 })])]);

    const buffer = await renderSchedule(schedule, { sampleRate: SAMPLE_RATE });

    expect(buffer.length).toBe(renderFrameCount(schedule, SAMPLE_RATE));
    expect(buffer.length).toBe(Math.ceil((0.5 + CLICK_FREE_RAMP) * SAMPLE_RATE));
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.sampleRate).toBe(SAMPLE_RATE);
  });

  it('renders at the requested sample rate', async () => {
    const schedule = makeSchedule([makeVoice([makeEntry({ duration: 0.5, baseFreq: 300 })])]);

    const buffer = await renderSchedule(schedule, { sampleRate: 22050 });

    expect(buffer.sampleRate).toBe(22050);
    expect(buffer.length).toBe(renderFrameCount(schedule, 22050));
  });

  it('reports progress and finishes at 1', async () => {
    const progress: number[] = [];

    await renderSchedule(makeSchedule([makeVoice([makeEntry({ duration: 0.2, baseFreq: 300 })])]), {
      sampleRate: SAMPLE_RATE,
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(progress.at(-1)).toBe(1);
    expect(progress.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
  });

  it('refuses a schedule with no audio in it', async () => {
    await expect(renderSchedule(makeSchedule([]))).rejects.toThrow('no audio to export');
  });

  it('settles as cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderSchedule(makeSchedule([makeVoice([makeEntry({ duration: 1, baseFreq: 300 })])]), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RenderCancelledError);
  });
});

/**
 * PLAN.md §5.3's definition of done: "WAV export of a fixture is null-test identical to realtime
 * playback (within float tolerance)."
 *
 * Realtime playback here is `PlaybackEngine` — the code path the player really uses — driven on
 * an `OfflineAudioContext` so its samples can be captured. The two paths differ only in when
 * schedule-time zero falls: `PlaybackEngine` puts it `CLICK_FREE_RAMP` after `play()`, since
 * every transition fades in over that window (§4.4), so playback is compared against the export
 * shifted by exactly that many frames.
 *
 * The schedule deliberately exercises the parts of the graph an export could plausibly get wrong:
 * two binaural voices (one of them `voice_mono`), a noise voice, an isochronic voice, asymmetric
 * `overallvolume_*` and `stereoswap`.
 *
 * **Its premises, both of which the isochronic voice extends rather than changes.**
 *
 * 1. *Every opening segment is flat in frequency.* `PlaybackEngine` holds frequency constant
 *    through its fade-in while the export is already ramping, so a sloping opening leaves the two
 *    oscillator phases a few thousandths of a cycle apart. Since step 10 that applies to a **gate**
 *    oscillator as well as a carrier, and matters more there: a gate slews between fully off and
 *    fully on in ~2.3 ms, so a misalignment costs far more than a phase error on a sine does. Both
 *    paths start every oscillator at `t0`, and the comparison below shifts by exactly the
 *    `CLICK_FREE_RAMP` frames between them — so if this test ever fails on the isochronic voice,
 *    suspect the alignment and not the gate.
 * 2. *The summed mix stays below full scale*, or the WAV's clamp is what is being compared.
 */
describe('WAV export null test (§5.3)', () => {
  const DURATION = 1.5;
  const FADE_FRAMES = Math.round(CLICK_FREE_RAMP * SAMPLE_RATE);

  /** Volumes are kept low enough that the summed mix never reaches full scale: a clipped export
   *  would be compared against unclipped playback and fail for the encoder's reasons rather than
   *  the export path's. Clamping has its own test in `wav.test.ts`. */
  function nullTestSchedule(): Schedule {
    return makeSchedule(
      [
        makeVoice([
          makeEntry({ duration: 0.5, baseFreq: 300, beatFreq: 10, volumeLeft: 0.4, volumeRight: 0.3 }),
          makeEntry({ duration: 0.5, baseFreq: 300, beatFreq: 10, volumeLeft: 0.4, volumeRight: 0.3 }),
          makeEntry({ duration: 0.5, baseFreq: 340, beatFreq: 6, volumeLeft: 0.2, volumeRight: 0.45 }),
        ]),
        makeVoice(
          [
            makeEntry({ duration: 0.75, baseFreq: 180, beatFreq: 4, volumeLeft: 0.25, volumeRight: 0.25 }),
            makeEntry({ duration: 0.75, baseFreq: 180, beatFreq: 4, volumeLeft: 0.15, volumeRight: 0.35 }),
          ],
          { id: 1, mono: true },
        ),
        makeVoice([makeEntry({ duration: DURATION, volumeLeft: 0.15, volumeRight: 0.1 })], {
          id: 2,
          type: VoiceType.PinkNoise,
        }),
        // Isochronic: one carrier gated at 9 Hz, flat across the opening segment so premise 1
        // covers its gate oscillator too.
        makeVoice(
          [
            makeEntry({ duration: 0.5, baseFreq: 220, beatFreq: 9, volumeLeft: 0.2, volumeRight: 0.2 }),
            makeEntry({ duration: 0.5, baseFreq: 220, beatFreq: 9, volumeLeft: 0.2, volumeRight: 0.2 }),
            makeEntry({ duration: 0.5, baseFreq: 260, beatFreq: 5, volumeLeft: 0.1, volumeRight: 0.2 }),
          ],
          { id: 3, type: VoiceType.IsoPulse },
        ),
      ],
      { masterVolume: { left: 0.9, right: 0.6 }, stereoSwap: true },
    );
  }

  async function renderViaPlayback(schedule: Schedule): Promise<AudioBuffer> {
    const frames = Math.ceil((DURATION + 2 * CLICK_FREE_RAMP) * SAMPLE_RATE);
    const context = new OfflineAudioContext(2, frames, SAMPLE_RATE);
    const engine = new PlaybackEngine(context as unknown as BaseAudioContext);
    engine.load(schedule);
    engine.play();
    return (await context.startRendering()) as unknown as AudioBuffer;
  }

  it('an exported WAV matches what the playback engine produces, within float tolerance', async () => {
    const schedule = nullTestSchedule();

    const played = await renderViaPlayback(schedule);
    const exported = await renderSchedule(schedule, { sampleRate: SAMPLE_RATE });
    const { channels } = decodeWav(await readBlob(encodeWav(exported)));

    // 16-bit quantisation is the floor on how close the decoded file can be; the small margin on
    // top absorbs the difference between the two contexts' automation arithmetic.
    const tolerance = 1 / 0x8000 + 1e-4;
    // Skip the fade-in at the head and the end-of-schedule fade at the tail — both are real, both
    // are compared elsewhere, and neither is sample-aligned between the two paths.
    const from = Math.round(0.05 * SAMPLE_RATE);
    const to = Math.round((DURATION - 0.05) * SAMPLE_RATE);

    let worst = 0;
    let peak = 0;
    let energy = 0;
    for (let channel = 0; channel < 2; channel++) {
      const live = played.getChannelData(channel);
      const file = channels[channel];
      for (let i = from; i < to; i++) {
        worst = Math.max(worst, Math.abs(live[i + FADE_FRAMES] - file[i]));
        peak = Math.max(peak, Math.abs(live[i + FADE_FRAMES]));
        energy += file[i] * file[i];
      }
    }

    expect(Math.sqrt(energy / (2 * (to - from)))).toBeGreaterThan(0.1); // a real signal, not silence
    expect(peak).toBeLessThan(1); // nothing clipped, so this compares the export and not the clamp
    expect(worst).toBeLessThan(tolerance);
  });
});

/**
 * The app-level noise bed in an export (§4.5b).
 *
 * Level and presence are what is checked, not samples against playback: `PlaybackEngine` starts the
 * layer's buffer sources at the transition instant while schedule-time zero is `CLICK_FREE_RAMP`
 * later, so the two paths run the same stream from phases a fade-window apart. That is why the
 * §5.3 null test above renders **without** a bed and is deliberately left alone.
 */
describe('the app-level noise bed in an export (§4.5b)', () => {
  const DURATION = 0.5;

  /** A voice that consumes time and makes no sound, so whatever is rendered is the bed alone. */
  function silentSchedule(duration = DURATION): Schedule {
    return makeSchedule([
      makeVoice([makeEntry({ duration, baseFreq: 300, volumeLeft: 0, volumeRight: 0 })]),
    ]);
  }

  function rms(samples: Float32Array): number {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  function peak(samples: Float32Array): number {
    return samples.reduce((worst, sample) => Math.max(worst, Math.abs(sample)), 0);
  }

  it('is absent unless the export asked for it', async () => {
    const buffer = await renderSchedule(silentSchedule(), { sampleRate: SAMPLE_RATE });

    expect(peak(buffer.getChannelData(0))).toBe(0);
    expect(peak(buffer.getChannelData(1))).toBe(0);
  });

  it('adds nothing at zero gain, which is the default nobody has touched', async () => {
    const buffer = await renderSchedule(silentSchedule(), {
      sampleRate: SAMPLE_RATE,
      noise: { colour: 'pink', gain: 0 },
    });

    expect(peak(buffer.getChannelData(0))).toBe(0);
  });

  it('mixes the bed at the level a voice of the same volume would sit at', async () => {
    // Long enough to measure: the Gnaural colour is a −6 dB/octave rumble, so a half-second
    // window is a few cycles of its lowest content and its RMS wanders by a few percent.
    const length = 3;
    const buffer = await renderSchedule(silentSchedule(length), {
      sampleRate: SAMPLE_RATE,
      noise: { colour: 'gnaural', gain: 0.5 },
    });

    // NOISE_REFERENCE_RMS × 0.5, the same figure the playback layer is pinned to.
    const to = Math.round(length * SAMPLE_RATE);
    expect(rms(buffer.getChannelData(0).subarray(0, to))).toBeCloseTo(0.145, 2);
    expect(rms(buffer.getChannelData(1).subarray(0, to))).toBeCloseTo(0.145, 2);
  });

  it('ends with the programme rather than running out with the file', async () => {
    const buffer = await renderSchedule(silentSchedule(), {
      sampleRate: SAMPLE_RATE,
      noise: { colour: 'white', gain: 0.5 },
    });

    expect(peak(buffer.getChannelData(0).subarray(Math.ceil((DURATION + CLICK_FREE_RAMP) * SAMPLE_RATE)))).toBe(0);
  });

  it('leaves the programme itself untouched — the bed is summed on top of it', async () => {
    const schedule = makeSchedule([
      makeVoice([makeEntry({ duration: DURATION, baseFreq: 300, beatFreq: 8, volumeLeft: 0.3, volumeRight: 0.3 })]),
    ]);

    const plain = await renderSchedule(schedule, { sampleRate: SAMPLE_RATE });
    const bedded = await renderSchedule(schedule, {
      sampleRate: SAMPLE_RATE,
      noise: { colour: 'gnaural', gain: 0.2 },
    });

    const to = Math.round(DURATION * SAMPLE_RATE);
    const difference = new Float32Array(to);
    for (let i = 0; i < to; i++) {
      difference[i] = bedded.getChannelData(0)[i] - plain.getChannelData(0)[i];
    }

    // What is left over when the programme is subtracted back out is the bed, at its own level.
    expect(rms(difference)).toBeCloseTo(0.29 * 0.2, 2);
  });
});
