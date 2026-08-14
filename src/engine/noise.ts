/**
 * Noise, for both of §4.5's separate concerns.
 *
 * **(a) The file's own noise voices (type 1)**, replicated from the reference implementation
 * (`reference/gnaural-src-20110606/src/BinauralBeat.c`) — `createNoiseBuffer`.
 *
 * **(b) The app-level noise layer**, a listening preference independent of any file, which offers
 * three further colours and levels them against each other — `createLayerNoiseBuffer`. The
 * generator, the seeding and the loop seam are shared; only the sampler and the level differ.
 *
 * Despite the constant's name (`BB_VOICETYPE_PINKNOISE`) this is not pink noise: `BB_LoPass`
 * (BinauralBeat.c:1103) is a one-pole lowpass on white, a −6 dB/octave rolloff closer to
 * brown/red. Replicated exactly rather than "fixed", since every existing schedule was authored
 * against this sound.
 *
 * Buffers are generated once and looped by an `AudioBufferSourceNode` (§4.5's prescribed
 * approach — an `AudioWorklet` would be inaudibly different and far more machinery), one buffer
 * per channel from an independent stream, because the source generates left and right from
 * separate random draws and the decorrelation is what makes it sound wide.
 */

/** Gnaural's sine peak, `BB_SIN_SCALER` (BinauralBeat.c:71) — the reference level noise is
 *  mixed against, so dividing by it puts our floats at the same tone-to-noise ratio. Shared with
 *  `water.ts`, which mixes its drops against the same reference. */
export const SIN_SCALER = 0x3fff;

/** `BB_Rand() >> 15` (BinauralBeat.c:717) — white input in ±2^16, before the lowpass. */
const WHITE_SHIFT = 15;

/** Full scale for the xorshift's int32 output, for the colours that work in floats. */
const INT32_SCALE = 0x80000000;

/** Long enough that the loop period isn't perceptible (§4.5). */
export const NOISE_BUFFER_SECONDS = 10;

/** Crossfade length at the loop seam, in seconds. */
const SEAM_CROSSFADE_SECONDS = 0.05;

/**
 * Seeded xorshift32.
 *
 * **Deliberate deviation from `BB_Rand()`** (BinauralBeat.c:1075), whose shift-register/MCG pair
 * runs on `unsigned long` — 64-bit on Linux — and so cannot be reproduced faithfully in JS.
 * Only the distribution matters for noise; what does matter is that the stream is *seeded*, so
 * that a WAV export and live playback of the same schedule produce identical samples and can be
 * null-tested against each other (PLAN.md §5.3). `water.ts` seeds its drop field from the same
 * generator, for the same reason.
 */
export function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1; // a zero state is a fixed point of the generator
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state | 0;
  };
}

/**
 * The colours the app-level noise layer offers (§4.5b). `gnaural` is the same generator the
 * file-driven voices use, so the app's bed can match the sound of a schedule's own noise voice.
 *
 * Values are persisted in `Settings`, so they are strings rather than an enum and must not be
 * renamed lightly.
 */
export type NoiseColour = 'gnaural' | 'white' | 'pink' | 'brown';

export const NOISE_COLOURS: NoiseColour[] = ['gnaural', 'white', 'pink', 'brown'];

/**
 * The level every colour of the app layer is generated at.
 *
 * This is the steady-state RMS of `BB_LoPass` scaled by `BB_SIN_SCALER` — i.e. the level a
 * file's own noise voice sits at when its `volume_*` is 1. Matching every colour to it is what
 * makes the layer's gain mean one thing: 0.3 on the control is as loud as a type-1 voice at
 * volume 0.3, whichever colour is chosen, and changing colour is a change of timbre rather than
 * of level. A test pins the Gnaural generator's own RMS against this constant.
 */
export const NOISE_REFERENCE_RMS = 0.29;

/** A colour's generator: given the raw stream, produce successive samples. */
type Sampler = (random: () => number) => () => number;

const SAMPLERS: Record<NoiseColour, Sampler> = {
  /**
   * `BB_LoPass` over white:
   *
   *     y[n] = ((y[n-1] * 31) + x[n]) >> 5
   *
   * kept in integer arithmetic like the original (JS `>>` is an arithmetic shift, matching C's on
   * the platforms Gnaural targets), then scaled to floats by the sine reference level.
   */
  gnaural: (random) => {
    let filtered = 0;
    return () => {
      filtered = ((filtered * 31) + (random() >> WHITE_SHIFT)) >> 5;
      return filtered / SIN_SCALER;
    };
  },

  white: (random) => () => random() / INT32_SCALE,

  /**
   * −3 dB/octave, via Paul Kellett's filter bank — six one-poles staggered an octave apart plus a
   * direct term, which tracks true pink to within about 0.05 dB over the audible range. Cheap
   * enough to be irrelevant here (it runs once, over ten seconds of buffer) and far simpler than
   * the alternative of an FFT-shaped noise.
   */
  pink: (random) => {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    return () => {
      const white = random() / INT32_SCALE;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      return pink;
    };
  },

  /**
   * −6 dB/octave everywhere: a leaky integrator over white, which is a rumble rather than a hiss.
   *
   * Audibly distinct from `gnaural` despite sharing a slope, because that one is a one-pole whose
   * corner sits around 200 Hz — flat below it and rolling off only above — while this rolls off
   * from DC. The leak keeps the integrator from wandering off into a DC offset.
   */
  brown: (random) => {
    let last = 0;
    return () => {
      last = (last + 0.02 * (random() / INT32_SCALE)) / 1.02;
      return last;
    };
  },
};

/**
 * One channel of noise, generated by `colour`'s sampler.
 *
 * The stream runs `SEAM_CROSSFADE_SECONDS` past the end of the buffer, and that tail is folded
 * back over the head: the head starts as the tail's natural continuation and fades into its own
 * samples. Without it the loop's end-to-start jump is a discontinuity of roughly the noise's own
 * amplitude — an audible tick every `NOISE_BUFFER_SECONDS`. Equal power (rather than linear)
 * holds the level constant across the fade, since the two overlapping stretches are
 * uncorrelated.
 */
function fillNoiseChannel(
  target: Float32Array,
  sampleRate: number,
  seed: number,
  colour: NoiseColour,
): void {
  const nextSample = SAMPLERS[colour](xorshift32(seed));
  const fade = Math.min(Math.round(SEAM_CROSSFADE_SECONDS * sampleRate), target.length);

  for (let i = 0; i < target.length; i++) target[i] = nextSample();

  for (let i = 0; i < fade; i++) {
    const weight = i / fade;
    target[i] = nextSample() * Math.sqrt(1 - weight) + target[i] * Math.sqrt(weight);
  }
}

/** Scale a filled buffer to a known RMS, so one gain control means the same thing for every
 *  colour. Measured rather than derived: the filters' gains are awkward closed-form and the
 *  buffer is right there. */
function normaliseLevel(target: Float32Array, rms: number): void {
  let sum = 0;
  for (const sample of target) sum += sample * sample;
  const measured = Math.sqrt(sum / target.length);
  if (measured === 0) return;

  const scale = rms / measured;
  for (let i = 0; i < target.length; i++) target[i] *= scale;
}

/**
 * A looping noise buffer for one channel of a **file-driven** noise voice (§4.5a, type 1).
 *
 * `seed` is derived from the voice's position so that separate voices get separate streams and
 * the same voice always gets the same one. Deliberately un-normalised: this is what existing
 * schedules were authored against, and its level is Gnaural's own.
 */
export function createNoiseBuffer(context: BaseAudioContext, seed: number): AudioBuffer {
  return noiseBuffer(context, seed, 'gnaural');
}

/**
 * A looping noise buffer for one channel of the **app-level** noise layer (§4.5b).
 *
 * The same generator, level-matched across colours — see `NOISE_REFERENCE_RMS`.
 */
export function createLayerNoiseBuffer(
  context: BaseAudioContext,
  seed: number,
  colour: NoiseColour,
): AudioBuffer {
  return noiseBuffer(context, seed, colour, NOISE_REFERENCE_RMS);
}

function noiseBuffer(
  context: BaseAudioContext,
  seed: number,
  colour: NoiseColour,
  rms?: number,
): AudioBuffer {
  const length = Math.round(NOISE_BUFFER_SECONDS * context.sampleRate);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const channel = buffer.getChannelData(0);

  fillNoiseChannel(channel, context.sampleRate, seed, colour);
  if (rms !== undefined) normaliseLevel(channel, rms);
  return buffer;
}

/** Seeds for a voice's two channels — independent streams, per §4.5's decorrelation. */
export function noiseSeeds(voiceIndex: number): [number, number] {
  return [0x9e3779b9 + voiceIndex * 2, 0x85ebca6b + voiceIndex * 2];
}

/** The app layer's own pair, kept clear of `noiseSeeds`'s range so its bed never correlates with
 *  a voice's noise however many voices a schedule has. */
export const LAYER_NOISE_SEEDS: [number, number] = [0x2545f491, 0xc2b2ae35];
