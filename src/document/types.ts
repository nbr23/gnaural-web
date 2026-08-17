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
 * The address of one node: index into `schedule.voices`, index into that voice's entries. Indices
 * rather than ids because voice ids are not unique in real files — the same keying the engine's
 * session mute/solo, the chart's hit results and the editor's `NodeRef` all use.
 */
export interface EntryLocation {
  voice: number;
  entry: number;
}

/** Values are fixed by the Gnaural format and must never be reassigned. */
export const enum VoiceType {
  Binaural = 0,
  PinkNoise = 1,
  Pcm = 2,          // never renderable — external file, path not in schedule
  IsoPulse = 3,
  IsoPulseAlt = 4,
  WaterDrops = 5,
  Rain = 6,
}

/**
 * Voice types this app makes a sound for. Everything else is parsed, preserved and silent. Stated
 * once, here, because the engine and `warnings.ts` must never disagree about what's audible — a
 * second copy would eventually let one silently drop a voice the other warns about. Every type the
 * format defines is here except PCM, which never can be: the schedule doesn't record the file path.
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
 * Voice types whose `basefreq` and `beatfreq` describe a tone (a carrier and a rate) — the only ones
 * the frequency validation rules and the player's readout mean anything for. Water drops and rain
 * read both fields too, but as a per-sample probability and a drop count, not a carrier and rate —
 * mixing them into the same chart lane would flatten every tone curve there. See `buildChartModel`.
 */
const TONAL_TYPES = new Set<VoiceType>([
  VoiceType.Binaural,
  VoiceType.IsoPulse,
  VoiceType.IsoPulseAlt,
]);

export function isTonalType(type: VoiceType): boolean {
  return TONAL_TYPES.has(type);
}
