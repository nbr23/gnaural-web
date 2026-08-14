export interface Schedule {
  title: string;
  description: string;
  author: string;
  loops: number;              // 1 = once; <1 = infinite
  masterVolume: { left: number; right: number };
  stereoSwap: boolean;
  voices: Voice[];
  /** Verbatim unrecognised schedule-level elements, for lossless round-trip. */
  preserved: Record<string, string>;
}

export interface Voice {
  id: number;
  description: string;
  type: VoiceType;
  muted: boolean;
  hidden: boolean;
  mono: boolean;
  entries: Entry[];
  preserved: Record<string, string>;
}

export interface Entry {
  duration: number;           // seconds, float
  baseFreq: number;           // Hz
  beatFreq: number;           // Hz
  volumeLeft: number;         // 0..1
  volumeRight: number;        // 0..1
  preserved: Record<string, string>;
}

/**
 * The address of one node: index into `schedule.voices`, index into that voice's entries.
 *
 * Indices rather than ids because §3.4's ids are not unique in real files — the same keying the
 * engine's session mute/solo, the chart's hit results and the editor's `NodeRef` all use. It lives
 * here so the validation surface and the edit transforms can share one type without either
 * depending on the other, and so that neither has to reach into `src/editor/`.
 */
export interface EntryLocation {
  voice: number;
  entry: number;
}

/** Values are fixed by the Gnaural format and must never be reassigned (PLAN.md §3.3). */
export const enum VoiceType {
  Binaural = 0,     // Phase 0
  PinkNoise = 1,    // Phase 0
  Pcm = 2,          // never renderable — external file, path not in schedule
  IsoPulse = 3,     // Phase 1
  IsoPulseAlt = 4,  // Phase 1
  WaterDrops = 5,   // Phase 1
  Rain = 6,         // Phase 1
}

/**
 * Voice types this app makes a sound for. Everything else is parsed, preserved and silent (§3.3).
 *
 * **Stated once, here, because two readers must never disagree**: the engine skips what it cannot
 * render, and `warnings.ts` promises the listener that everything else was heard. A second copy
 * would eventually either silently drop a voice — §3.3's one prohibition — or warn about one that
 * is sounding. Every type the format defines is here except type 2 (PCM), which never can be: the
 * schedule does not record where the audio file is.
 */
const RENDERABLE_TYPES = new Set<VoiceType>([
  VoiceType.Binaural,
  VoiceType.PinkNoise,
  VoiceType.IsoPulse,
  VoiceType.IsoPulseAlt,
  VoiceType.WaterDrops,
  VoiceType.Rain,
]);

export function isRenderableType(type: VoiceType): boolean {
  return RENDERABLE_TYPES.has(type);
}

/**
 * Voice types whose `basefreq` and `beatfreq` describe a tone — the only ones for which those two
 * fields mean a carrier and a rate, and so the only ones the §6.1 frequency rules and the player's
 * readout mean anything for.
 *
 * Noise (type 1) reads neither: all nine noise voices in the bundled corpus carry base 100 and beat
 * 0. Water drops and rain (types 5 and 6) read both, but as neither a carrier nor a rate — the base
 * is a per-sample probability and the first `beatfreq` is a drop count (§3.3). An isochronic voice
 * reads both, differently from a binaural one but no less literally: the base is its tone and the
 * beat is the rate that tone is switched on and off at.
 *
 * It is also what the chart fits its two frequency lanes to: a probability of 0.00035 drawn beside a
 * carrier at 200 Hz flattens every tone curve in the lane, and a drop count of 100 does the same to
 * the beat lane. See `buildChartModel`.
 */
const TONAL_TYPES = new Set<VoiceType>([
  VoiceType.Binaural,
  VoiceType.IsoPulse,
  VoiceType.IsoPulseAlt,
]);

export function isTonalType(type: VoiceType): boolean {
  return TONAL_TYPES.has(type);
}
