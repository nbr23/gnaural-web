import type { Entry, Voice } from '../document/types';

export interface AutomationEvent {
  time: number;       // seconds, relative to voice/schedule start
  leftFreq: number;
  rightFreq: number;
  leftGain: number;
  rightGain: number;
}

function eventValues(entry: Entry): Omit<AutomationEvent, 'time'> {
  return {
    // §3.6 — voices are symmetric around basefreq; left carries the higher frequency.
    leftFreq: entry.baseFreq + entry.beatFreq / 2,
    rightFreq: entry.baseFreq - entry.beatFreq / 2,
    leftGain: entry.volumeLeft,
    rightGain: entry.volumeRight,
  };
}

/**
 * Compile a voice's entries into a breakpoint automation curve.
 *
 * Pure function — no audio, no DOM. One event per entry at its absolute start time, plus a
 * final event at the voice's total duration carrying entry[0]'s values: PLAN.md §3.5 states the
 * last entry always ramps back to the first entry's values, unconditionally, whether or not the
 * schedule loops. Each event's `leftFreq`/`rightFreq`/`leftGain`/`rightGain` is the value at
 * that instant; linear interpolation between consecutive events (e.g.
 * `linearRampToValueAtTime`) reproduces Gnaural's per-sample `spread * factor + start` formula
 * exactly.
 */
export function compileVoice(voice: Voice): AutomationEvent[] {
  const { entries } = voice;
  if (entries.length === 0) return [];

  const events: AutomationEvent[] = [];
  let time = 0;
  for (const entry of entries) {
    events.push({ time, ...eventValues(entry) });
    time += entry.duration;
  }
  events.push({ time, ...eventValues(entries[0]) });

  return events;
}
