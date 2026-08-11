/**
 * Gnaural's noise voice (type 1), replicated from the reference implementation
 * (`reference/gnaural-src-20110606/src/BinauralBeat.c`, PLAN.md §4.5a).
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
 *  mixed against, so dividing by it puts our floats at the same tone-to-noise ratio. */
const SIN_SCALER = 0x3fff;

/** `BB_Rand() >> 15` (BinauralBeat.c:717) — white input in ±2^16, before the lowpass. */
const WHITE_SHIFT = 15;

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
 * null-tested against each other (PLAN.md §5.3).
 */
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1; // a zero state is a fixed point of the generator
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state | 0;
  };
}

/**
 * One channel of Gnaural noise, filled with `BB_LoPass` over white:
 *
 *     y[n] = ((y[n-1] * 31) + x[n]) >> 5
 *
 * kept in integer arithmetic like the original (JS `>>` is an arithmetic shift, matching C's on
 * the platforms Gnaural targets), then scaled to floats by the sine reference level.
 *
 * The stream runs `SEAM_CROSSFADE_SECONDS` past the end of the buffer, and that tail is folded
 * back over the head: the head starts as the tail's natural continuation and fades into its own
 * samples. Without it the loop's end-to-start jump is a discontinuity of roughly the noise's own
 * amplitude — an audible tick every `NOISE_BUFFER_SECONDS`. Equal power (rather than linear)
 * holds the level constant across the fade, since the two overlapping stretches are
 * uncorrelated.
 */
function fillNoiseChannel(target: Float32Array, sampleRate: number, seed: number): void {
  const random = xorshift32(seed);
  const fade = Math.min(Math.round(SEAM_CROSSFADE_SECONDS * sampleRate), target.length);

  let filtered = 0;
  const nextSample = (): number => {
    filtered = ((filtered * 31) + (random() >> WHITE_SHIFT)) >> 5;
    return filtered / SIN_SCALER;
  };

  for (let i = 0; i < target.length; i++) target[i] = nextSample();

  for (let i = 0; i < fade; i++) {
    const weight = i / fade;
    target[i] = nextSample() * Math.sqrt(1 - weight) + target[i] * Math.sqrt(weight);
  }
}

/**
 * A looping noise buffer for one channel of one voice.
 *
 * `seed` is derived from the voice's position so that separate voices get separate streams and
 * the same voice always gets the same one.
 */
export function createNoiseBuffer(context: BaseAudioContext, seed: number): AudioBuffer {
  const length = Math.round(NOISE_BUFFER_SECONDS * context.sampleRate);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  fillNoiseChannel(buffer.getChannelData(0), context.sampleRate, seed);
  return buffer;
}

/** Seeds for a voice's two channels — independent streams, per §4.5's decorrelation. */
export function noiseSeeds(voiceIndex: number): [number, number] {
  return [0x9e3779b9 + voiceIndex * 2, 0x85ebca6b + voiceIndex * 2];
}
