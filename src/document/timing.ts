import type { Schedule, Voice } from './types';

// Derived timing for a schedule. Every count and duration comes from the entries themselves, never
// from the declared `totaltime`/`entrycount` fields, which are stale in real files.

/** Total length of a voice: the sum of its entries' durations. */
export function voiceDuration(voice: Voice): number {
  return voice.entries.reduce((total, entry) => total + entry.duration, 0);
}

/**
 * Absolute start time of every entry, by prefix sum over the durations before it. Entries store
 * *duration* rather than absolute time, which is what makes an insertion a local edit.
 */
export function entryStartTimes(voice: Voice): number[] {
  const starts: number[] = [];
  let time = 0;
  for (const entry of voice.entries) {
    starts.push(time);
    time += entry.duration;
  }
  return starts;
}

/**
 * How long the schedule actually plays for: the shortest voice, not the longest. Gnaural's main loop
 * resets every voice as soon as the first one exhausts its entries. Every voice counts, including
 * ones this app does not render — an unplayable voice still consumes time and can end the schedule.
 */
export function scheduleDuration(schedule: Schedule): number {
  const durations = schedule.voices.map(voiceDuration);
  return durations.length > 0 ? Math.min(...durations) : 0;
}

/**
 * Voice durations closer together than this count as equal. Shared by the chart's truncation rule
 * and the warning that names the offending voices, so the two can never disagree.
 */
export const DURATION_EPSILON = 0.05;

/** The longest voice — how much of the schedule there is to *draw*, so no curve gets cropped. */
export function longestVoiceDuration(schedule: Schedule): number {
  const durations = schedule.voices.map(voiceDuration);
  return durations.length > 0 ? Math.max(...durations) : 0;
}
