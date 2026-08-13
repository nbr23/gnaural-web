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
