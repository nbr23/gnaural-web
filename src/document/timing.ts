import type { Schedule, Voice } from './types';

/**
 * Derived timing for a schedule. Pure document-layer arithmetic — every count and duration comes
 * from the entries themselves, never from the declared `totaltime`/`entrycount` fields, which
 * PLAN.md §3.4 says are stale in real files.
 */

/** Total length of a voice: the sum of its entries' durations. */
export function voiceDuration(voice: Voice): number {
  return voice.entries.reduce((total, entry) => total + entry.duration, 0);
}

/**
 * How long the schedule actually plays for.
 *
 * The **shortest** voice, not the longest: Gnaural's main loop resets every voice as soon as the
 * first one exhausts its entries, so a schedule's effective length is that of its shortest voice
 * even though `totaltime` records the longest (§3.7). Every voice counts, including ones this
 * app does not render — a voice type it cannot play still consumes time and can still end the
 * schedule.
 */
export function scheduleDuration(schedule: Schedule): number {
  const durations = schedule.voices.map(voiceDuration);
  return durations.length > 0 ? Math.min(...durations) : 0;
}

/**
 * Voice durations closer together than this count as equal (§3.7 — "differ by more than a rounding
 * error"). Shared by the chart's truncation rule and the warning that names the offending voices,
 * so the picture and the text can never disagree about whether a schedule is ragged.
 */
export const DURATION_EPSILON = 0.05;

/** The longest voice — how much of the schedule there is to *draw*, so no curve gets cropped. */
export function longestVoiceDuration(schedule: Schedule): number {
  const durations = schedule.voices.map(voiceDuration);
  return durations.length > 0 ? Math.max(...durations) : 0;
}
