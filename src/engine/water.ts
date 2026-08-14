/**
 * Water drops and rain — voice types 5 and 6 (§3.3), replicated from `BB_WaterInit`
 * (BinauralBeat.c:1160), `BB_WaterVoiceInit` (:1134) and `BB_Water` (:1188).
 *
 * **One drop, played backwards, many times over.** `BB_WaterInit` builds a single array holding a
 * sine of `arrayLength / pitch` cycles whose amplitude ramps *linearly up* to `0x7fff`; drops play
 * from the end of that array towards the front, so what is heard is a decaying blip. A voice keeps N
 * slots, each either playing a drop or waiting; an idle slot starts a new one with probability
 * `basefreq` per sample, at a random playback rate and a random stereo position. The mix then goes
 * through `BB_LoPass` — the same one-pole `noise.ts` already ports — and out.
 *
 * **The two types are one code path and three constants** (`WATER_SPECS`), as types 3 and 4 were one
 * gate and two labels. `decrement` is a random playback rate in `[lowCut, lowCut + 126)`, so it sets
 * pitch and length together, inversely:
 *
 * - **Water drops**: 13.65 cycles over 8192 elements — blips of 588–9850 Hz lasting 1.4–23 ms.
 * - **Rain**: 12.94 cycles over 44 elements puts *every* rate at or past Nyquist, so rain is not a
 *   tick at a pitch at all but a filtered impulse of 0.3–6.6 ms. That is why its `lowCut` is 0.15,
 *   and why `BB_LoPass` carries more of the sound here than anywhere else in this codebase.
 *
 * **Neither parameter is automatable, and that is the format rather than a shortcut.** The drop
 * count is read once from `Entry[0]` (:1134), and Gnaural's own GUI creates these voices with
 * exactly one entry spanning the whole schedule (`main.c:3788`), so a *varying* probability is not
 * something the authoring tool produces. Both are therefore fixed from `entry[0]` here, and a buffer
 * is generated once and looped exactly as a noise voice's is (§4.5) — which is also what lets an
 * export be null-tested against playback (§5.3).
 *
 * **Deliberate deviation: sample-rate normalisation.** `BB_AUDIOSAMPLERATE` is hardcoded 44100 and
 * the reference's own comment admits it does not know what happens otherwise. Three quantities are
 * stated in samples and all three are scaled by the same `44100/sr`: the seeding threshold (a chance
 * *per sample*, so drops per second follow), the playback rate (elements per sample, so both a
 * drop's pitch and its length in seconds follow) and `BB_LoPass`'s coefficient (see
 * `foldAndFilter`). Without it a 22.05 kHz export is a different sound, not a smaller file.
 *
 * **What that cannot fix is rain's level**, and it is the signal rather than the code: rain's drops
 * are impulses a sample or two long, and an impulse is not a rate-invariant object — halve the rate
 * and each one stands for twice as much time. Measured, rain is 8% quieter at 48 kHz and 1.9× louder
 * at 22.05 kHz; water drops, whose blips are always tens of samples long, hold their level to within
 * a few percent across the same span.
 */

import type { Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { NOISE_BUFFER_SECONDS, SIN_SCALER, xorshift32 } from './noise';

/** The two types this module renders. */
export type WaterType = VoiceType.WaterDrops | VoiceType.Rain;

interface WaterSpec {
  /** Length of the single drop array, `BB_DROPLEN` / `BB_RAINLEN` (BinauralBeat.c:60-61). */
  arrayLength: number;
  /** Elements per cycle of the sine inside it (:1171). */
  pitch: number;
  /** Floor on a drop's playback rate — `Lowcut` at the call sites (:812, :823). */
  lowCut: number;
}

const WATER_SPECS: Record<WaterType, WaterSpec> = {
  [VoiceType.WaterDrops]: { arrayLength: 8192, pitch: 600, lowCut: 8 },
  [VoiceType.Rain]: { arrayLength: 44, pitch: 3.4, lowCut: 0.15 },
};

/** Width of the random playback-rate window, `Window` (:1194). */
const DECREMENT_WINDOW = 126;

/** The rate the reference hardcodes, and so the rate its constants are stated at. */
const REFERENCE_RATE = 44100;

/** Slot count for a voice whose `beatfreq` is below 1 — the reference's own default (:1141). */
const DEFAULT_DROPS = 2;

/** Ceiling on the slot count (:1143). */
const MAX_DROPS = 100;

export function isWaterType(type: VoiceType): type is WaterType {
  return type === VoiceType.WaterDrops || type === VoiceType.Rain;
}

/**
 * How many drops can sound at once, from `entry[0].beatfreq` (:1134 — `beatfreq_start_HALF * 2`,
 * and `main.c:1311` sets that half from `beatfreq`, so this is just the truncated `beatfreq`).
 *
 * **The floor is 1, not 2**: the reference substitutes its default only when the count comes out
 * *below* one, so a `beatfreq` of 1 really does give a single slot.
 */
export function waterDropCount(beatFreq: number): number {
  const drops = Number.isFinite(beatFreq) ? Math.trunc(beatFreq) : 0;
  if (drops < 1) return DEFAULT_DROPS;
  return Math.min(MAX_DROPS, drops);
}

/** Seeds a voice's drop field. Kept clear of `noiseSeeds` and `LAYER_NOISE_SEEDS` so a water voice
 *  never shares a stream with noise however many voices a schedule has. */
export function waterSeed(voiceIndex: number): number {
  return 0x27d4eb2f + voiceIndex * 2;
}

export interface WaterField {
  type: WaterType;
  /** Slots, i.e. how many drops can overlap. Fixed for the voice. */
  drops: number;
  /** Per-slot, per-sample chance that an idle slot starts a drop (`dropthresh`, :1191). */
  probability: number;
  /** Mixes every drop whole into both channels instead of panning it (:1201). */
  mono: boolean;
  seed: number;
}

/**
 * What a voice's drop field is, read off `entry[0]`.
 *
 * A voice with no entries gets a probability of zero, which is **silence** — and that is the
 * reference's behaviour rather than a gap. `main.c:617` promises raindrop defaults for a voice
 * left at zero, but `dropthresh = cur_basefreq` makes the comparison never true and nothing below
 * `BB_MainLoop` supplies a default; what supplies it is the GUI, when the voice is created.
 */
export function waterField(voice: Voice, index: number): WaterField {
  const entry = voice.entries[0];
  return {
    type: voice.type === VoiceType.Rain ? VoiceType.Rain : VoiceType.WaterDrops,
    drops: waterDropCount(entry?.beatFreq ?? 0),
    probability: Math.max(0, entry?.baseFreq ?? 0),
    mono: voice.mono,
    seed: waterSeed(index),
  };
}

/**
 * The single drop every slot plays, `BB_WaterInit` (:1160).
 *
 * Amplitude ramps up across the array and playback runs backwards, so the drop decays. The
 * truncation is the reference's `(short)` cast.
 */
export function dropArray(type: WaterType): Int16Array {
  const { arrayLength, pitch } = WATER_SPECS[type];
  const array = new Int16Array(arrayLength);
  const step = 0x7fff / arrayLength;

  let phase = 0;
  let amplitude = 0;
  for (let i = 0; i < arrayLength; i++) {
    array[i] = Math.trunc(amplitude * Math.sin(phase * Math.PI * 2));
    phase += 1 / pitch;
    amplitude += step;
  }
  return array;
}

/**
 * A voice's two looping channels of drops.
 *
 * One field feeds both, unlike a noise voice's independent streams, because the reference's slots
 * are shared between the channels — a drop is *placed* in the stereo image rather than happening
 * separately in each ear. Under `mono` the two channels are the same buffer, since every drop is
 * mixed into both whole.
 */
export function createWaterBuffers(
  context: BaseAudioContext,
  field: WaterField,
): [AudioBuffer, AudioBuffer] {
  const [left, right] = fillWaterField(field, context.sampleRate);
  if (left === right) {
    const shared = toBuffer(context, left);
    return [shared, shared];
  }
  return [toBuffer(context, left), toBuffer(context, right)];
}

function toBuffer(context: BaseAudioContext, samples: Float32Array): AudioBuffer {
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

/**
 * Run the field for one buffer's worth of samples, plus the tail of any drop still sounding at the
 * end.
 *
 * `BB_Water` runs per sample over every slot; an active slot mixes the array value it has reached
 * and advances by its own rate, an idle one rolls for a new drop. The three random draws happen
 * whether or not `mono` is set, so a mono voice contains exactly the same drops as a stereo one and
 * differs only in how they are mixed.
 */
function fillWaterField(field: WaterField, sampleRate: number): [Float32Array, Float32Array] {
  const spec = WATER_SPECS[field.type];
  const rate = sampleRate / REFERENCE_RATE;
  const threshold = field.probability / rate;
  const array = dropArray(field.type);

  const length = Math.round(NOISE_BUFFER_SECONDS * sampleRate);
  // The longest a drop can last, at the slowest rate the window allows: what has to be folded back
  // over the head for the loop to be seamless.
  const tail = Math.ceil((spec.arrayLength * rate) / spec.lowCut);

  const random = xorshift32(field.seed);
  const next = () => (random() >>> 0) / 0x1_0000_0000;

  const mixL = new Float64Array(length + tail);
  // Mono mixes every drop whole into both channels, so there is only one signal to build.
  const mixR = field.mono ? mixL : new Float64Array(length + tail);

  // A slot starts at count 0 rather than idle: the reference `calloc`s them and tests `0 <= count`,
  // so a fresh slot plays `array[0]` — which is exactly 0 — once, and is idle from the next sample.
  const counts = new Float64Array(field.drops);
  const decrements = new Float64Array(field.drops).fill(1);
  const stereoMix = new Float64Array(field.drops).fill(0.5);

  for (let i = 0; i < mixL.length; i++) {
    let left = 0;
    let right = 0;

    for (let slot = 0; slot < field.drops; slot++) {
      if (counts[slot] >= 0) {
        const value = array[counts[slot] | 0];
        if (field.mono) {
          left += value;
        } else {
          // `(int)` truncation per drop, as the reference does it — the two channels therefore sum
          // to a shade under the whole drop rather than exactly to it.
          left += Math.trunc(value * stereoMix[slot]);
          right += Math.trunc(value * (1 - stereoMix[slot]));
        }
        counts[slot] -= decrements[slot];
      } else if (threshold > next()) {
        counts[slot] = spec.arrayLength - 1;
        decrements[slot] = (next() * DECREMENT_WINDOW + spec.lowCut) / rate;
        stereoMix[slot] = next();
      }
    }

    mixL[i] = left;
    if (!field.mono) mixR[i] = right;
  }

  const channelL = foldAndFilter(mixL, length, tail, rate);
  return [channelL, field.mono ? channelL : foldAndFilter(mixR, length, tail, rate)];
}

/**
 * Close the loop, then filter it — the two halves of making a *seamless* buffer of transients.
 *
 * **The seam is not `noise.ts`'s equal-power crossfade.** Drops are additive, so the exact answer is
 * to add the overhanging tail back into the head: a drop that crosses the end contributes precisely
 * what an endless repetition would, with no fade and no level dip. A crossfade would instead mix two
 * unrelated drop fields and audibly duck the level twice a loop.
 *
 * **`BB_LoPass` then runs twice, and that is what makes the filter periodic too.** Its state at the
 * start of the buffer has to be the state the end of the buffer hands back; a single pass from zero
 * would start silent and arrive at the seam somewhere else, leaving a step there. The pole is 31/32,
 * so one discarded pass over ten seconds settles the state to far below float precision.
 *
 * **The filter is normalised to the sample rate too, and it has to be.** `BB_LoPass` is
 * `y += (x - y) >> 5` — a corner fixed in *samples*, so at half the rate it lets twice as much of
 * each transient through: measured, a 22.05 kHz render of the same drops is three times as loud,
 * which is worse than the half-pitch it would have had without any normalisation at all, and the
 * export panel offers exactly that rate. Holding the time constant instead keeps the texture and
 * the level the same at every rate. `1/32` at 44.1 kHz makes this **bit-identical** to the
 * reference, since `((y * 31) + x) >> 5` is precisely `y + floor((x - y) / 32)`.
 */
function foldAndFilter(mix: Float64Array, length: number, tail: number, rate: number): Float32Array {
  for (let i = 0; i < tail; i++) mix[i] += mix[length + i];

  const alpha = Math.min(1, 1 / 32 / rate);
  const channel = new Float32Array(length);
  let filtered = 0;
  // Integer arithmetic throughout, like `noise.ts` — this is the shift, written so the coefficient
  // can move off 1/32.
  for (let i = 0; i < length; i++) filtered += Math.floor((mix[i] - filtered) * alpha);
  for (let i = 0; i < length; i++) {
    filtered += Math.floor((mix[i] - filtered) * alpha);
    channel[i] = filtered / SIN_SCALER;
  }
  return channel;
}
