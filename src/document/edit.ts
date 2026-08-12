import { entryStartTimes } from './timing';
import type { Entry, Schedule, Voice } from './types';

/**
 * Pure edit transforms: `(schedule, args) => Schedule`, no React, no engine, no storage.
 *
 * PLAN.md §4.1 makes the document immutable so that undo/redo is a stack of documents and "did this
 * change?" is a reference comparison. Both properties are the transforms' to keep, not the model's:
 *
 * - **Everything untouched keeps its identity.** An edit to one voice reuses every other voice, and
 *   an edit to one entry reuses every other entry. That is what makes a snapshot cost about a
 *   kilobyte instead of the whole document, and it is what the history stack's memory budget rests
 *   on — so `edit.test.ts` asserts it with `===` rather than trusting it.
 * - **A no-op returns the very same object.** Retyping a title that is already there must not push
 *   an undo step, and the caller checks that by identity rather than by comparing fields it would
 *   have to know about.
 *
 * `preserved` is carried through untouched at every level (§3.4 — unrecognised data survives a
 * round-trip, including one that goes through the editor).
 */

/**
 * The schedule's own header. Everything here is a document field the file format carries, so every
 * one of them is undoable and every one of them serializes.
 *
 * Deliberately a patch rather than a setter each: §6.1 asks for named commands, and the name belongs
 * to the commit ("Rename program"), not to the function. `updateVoice` and `updateEntry` will take
 * the same shape.
 */
export type SchedulePatch = Partial<
  Pick<Schedule, 'title' | 'description' | 'author' | 'loops' | 'masterVolume' | 'stereoSwap'>
>;

export function updateSchedule(schedule: Schedule, patch: SchedulePatch): Schedule {
  if (!changesSchedule(schedule, patch)) return schedule;
  return { ...schedule, ...patch };
}

function changesSchedule(schedule: Schedule, patch: SchedulePatch): boolean {
  for (const key of Object.keys(patch) as (keyof SchedulePatch)[]) {
    if (key === 'masterVolume') {
      const next = patch.masterVolume;
      if (!next) continue;
      if (next.left !== schedule.masterVolume.left) return true;
      if (next.right !== schedule.masterVolume.right) return true;
      continue;
    }
    if (patch[key] !== schedule[key]) return true;
  }
  return false;
}

/**
 * One entry's own values. Every field the `.gnaural` `<entry/>` element carries except `preserved`,
 * which is never patched — §3.4 keeps unrecognised data verbatim, including through the editor.
 */
export type EntryPatch = Partial<
  Pick<Entry, 'duration' | 'baseFreq' | 'beatFreq' | 'volumeLeft' | 'volumeRight'>
>;

export function updateEntry(
  schedule: Schedule,
  voiceIndex: number,
  entryIndex: number,
  patch: EntryPatch,
): Schedule {
  const voice = schedule.voices[voiceIndex];
  const entry = voice?.entries[entryIndex];
  if (!entry) return schedule;

  const keys = Object.keys(patch) as (keyof EntryPatch)[];
  if (!keys.some((key) => patch[key] !== undefined && patch[key] !== entry[key])) return schedule;

  return replaceEntries(schedule, voiceIndex, (entries) =>
    entries.map((current, index) => (index === entryIndex ? { ...current, ...patch } : current)),
  );
}

/**
 * How a time drag treats the segment that follows the node being moved.
 *
 * **Squeeze is the default and ripple is the modifier**, and the reason is §3.7 rather than taste: a
 * voice's length is the sum of its durations, the *shortest* voice is the schedule's length, and all
 * 19 bundled files have a voice-duration spread of exactly zero. Rippling one voice of a multi-voice
 * schedule therefore changes how long the whole program plays and raises the ragged-schedule warning
 * on the user's own drag.
 */
export type MoveMode = 'squeeze' | 'ripple';

export interface MoveEntryArgs {
  voice: number;
  entry: number;
  /** Where the entry should start, in seconds from the voice's own beginning. */
  time: number;
  mode: MoveMode;
}

/**
 * Move an entry along the time axis, by rewriting the durations either side of it.
 *
 * Three consequences of the format, implemented rather than discovered:
 *
 * - **Entry 0 cannot move.** Its start is the sum of no durations, which is zero by definition; only
 *   its values are editable.
 * - **The last entry necessarily ripples**, whatever the mode says, because it has no following
 *   segment to squeeze into. Moving it is how a voice's total length is changed by dragging.
 * - **Both modes clamp at zero duration**, so a node can reach its neighbour and stop rather than
 *   passing it. The presets' 0.001 s entries make that the common case, not an edge one.
 */
export function moveEntry(schedule: Schedule, args: MoveEntryArgs): Schedule {
  const { voice: voiceIndex, entry: entryIndex, mode } = args;
  const voice = schedule.voices[voiceIndex];
  if (!voice || entryIndex <= 0 || entryIndex >= voice.entries.length) return schedule;

  const starts = entryStartTimes(voice);
  const previousStart = starts[entryIndex - 1];
  const nextStart = starts[entryIndex + 1];
  const squeezing = mode === 'squeeze' && nextStart !== undefined;

  const time = Math.max(previousStart, squeezing ? Math.min(args.time, nextStart) : args.time);
  const delta = time - starts[entryIndex];
  if (delta === 0) return schedule;

  return replaceEntries(schedule, voiceIndex, (entries) =>
    entries.map((entry, index) => {
      if (index === entryIndex - 1) return { ...entry, duration: entry.duration + delta };
      if (index === entryIndex && squeezing) return { ...entry, duration: entry.duration - delta };
      return entry;
    }),
  );
}

/** Rebuild one voice's entry list, reusing the schedule's other voices and their arrays. */
function replaceEntries(
  schedule: Schedule,
  voiceIndex: number,
  rewrite: (entries: Entry[]) => Entry[],
): Schedule {
  const voices = schedule.voices.map<Voice>((voice, index) =>
    index === voiceIndex ? { ...voice, entries: rewrite(voice.entries) } : voice,
  );
  return { ...schedule, voices };
}
