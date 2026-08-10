import type { Entry, Voice } from '../document/types';

/** The value half of an automation event — what `valueAtTime` returns, minus the timestamp. */
export type AutomationValues = Omit<AutomationEvent, 'time'>;

export interface AutomationEvent {
  time: number;       // seconds, relative to voice/schedule start
  leftFreq: number;
  rightFreq: number;
  leftGain: number;
  rightGain: number;
}

function eventValues(entry: Entry): AutomationValues {
  return {
    // §3.6 — voices are symmetric around basefreq; left carries the higher frequency.
    leftFreq: entry.baseFreq + entry.beatFreq / 2,
    rightFreq: entry.baseFreq - entry.beatFreq / 2,
    leftGain: entry.volumeLeft,
    rightGain: entry.volumeRight,
  };
}

/**
 * Recover the base (carrier) frequency from an event's per-channel pair — the exact inverse of
 * the §3.6 assignment applied in `eventValues`, kept beside it so the left-is-higher convention
 * lives in one place. Takes the value half alone, so a `valueAtTime` result can be fed straight
 * in without reconstructing an event.
 */
export function eventBaseFreq(event: AutomationValues): number {
  return (event.leftFreq + event.rightFreq) / 2;
}

/** Recover the beat frequency from an event's per-channel pair (inverse of §3.6). */
export function eventBeatFreq(event: AutomationValues): number {
  return event.leftFreq - event.rightFreq;
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

/**
 * Interpolate a compiled voice's automation curve at an arbitrary offset — the same
 * `spread * factor + start` linear interpolation `compileVoice`'s breakpoints are designed to
 * reproduce via `linearRampToValueAtTime` (§3.5), evaluated directly instead of scheduled.
 *
 * Used to re-anchor `AudioParam`s at the correct value when seeking or resuming mid-curve
 * (PLAN.md §4.3's `rescheduleFrom`). Clamps to the first event's value before it and the last
 * event's value after it, matching how Web Audio holds a param's value outside its scheduled
 * range.
 */
export function valueAtTime(events: AutomationEvent[], t: number): AutomationValues {
  if (events.length === 0) return { leftFreq: 0, rightFreq: 0, leftGain: 0, rightGain: 0 };
  if (t <= events[0].time) return stripTime(events[0]);

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (t <= b.time) {
      const factor = b.time === a.time ? 1 : (t - a.time) / (b.time - a.time);
      return {
        leftFreq: a.leftFreq + (b.leftFreq - a.leftFreq) * factor,
        rightFreq: a.rightFreq + (b.rightFreq - a.rightFreq) * factor,
        leftGain: a.leftGain + (b.leftGain - a.leftGain) * factor,
        rightGain: a.rightGain + (b.rightGain - a.rightGain) * factor,
      };
    }
  }

  return stripTime(events[events.length - 1]);
}

function stripTime(event: AutomationEvent): AutomationValues {
  const { time: _time, ...rest } = event;
  return rest;
}
