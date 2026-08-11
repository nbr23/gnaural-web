import type { Schedule } from './types';

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
