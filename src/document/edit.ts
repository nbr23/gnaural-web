import { entryStartTimes, longestVoiceDuration, scheduleDuration } from './timing';
import type { Entry, EntryLocation, Schedule, Voice } from './types';
import { VoiceType } from './types';
import type { VoiceMap } from './voiceMap';
import { identityVoiceMap, insertVoiceMap, moveVoiceMap, removeVoiceMap } from './voiceMap';

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

/**
 * The entry fields that are a *value* on a curve, which is every one a lane can draw and every one
 * a drag can change. `duration` is deliberately not among them: it is a length, the chart puts it on
 * the x-axis rather than in a lane, and moving a node in time rewrites two of them at once.
 */
export type EntryValueField = 'baseFreq' | 'beatFreq' | 'volumeLeft' | 'volumeRight';

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

/**
 * The voice fields §6.1 asks the editor's voice list for. `type` and `mono` are deliberately absent:
 * there is no control for either, and a patch field with no caller is a capability nobody can
 * exercise. `id` is absent because nothing may renumber a voice — see `insertVoice`.
 */
export type VoicePatch = Partial<Pick<Voice, 'description' | 'muted' | 'hidden'>>;

export function updateVoice(schedule: Schedule, voiceIndex: number, patch: VoicePatch): Schedule {
  const voice = schedule.voices[voiceIndex];
  if (!voice) return schedule;

  const keys = Object.keys(patch) as (keyof VoicePatch)[];
  if (!keys.some((key) => patch[key] !== undefined && patch[key] !== voice[key])) return schedule;

  const voices = schedule.voices.map((current, index) =>
    index === voiceIndex ? { ...current, ...patch } : current,
  );
  return { ...schedule, voices };
}

export interface InsertEntryArgs {
  voice: number;
  /** The entry whose segment is split. Its own start is untouched; the new node lands after it. */
  after: number;
  /** Where to split, in seconds from the voice's start. The segment's midpoint by default. */
  time?: number;
}

/**
 * Add a breakpoint by **splitting a segment**, values interpolated off the curve §3.5 defines.
 *
 * The durations either side sum to the one they replace, so the voice's length does not change and
 * §3.7's spread — exactly zero in all 19 bundled files — survives. That is the same argument that
 * made squeeze rather than ripple the default for a time drag.
 *
 * **The insert is audibly a no-op by construction.** The curve through the new node is the curve
 * that was already there; what the edit adds is a handle on it. Anything else would mean that
 * asking for a control point changed the sound.
 *
 * **The final segment needs no special case, which is not obvious.** §3.5's unconditional wrap *is*
 * the last entry's segment: it starts at the last entry's values, ends at entry[0]'s, and lasts the
 * last entry's duration. So splitting it is the ordinary operation, and what comes out is a new
 * final entry with the wrap running from there instead. A one-entry voice splits the same way — its
 * single segment is a constant hold from entry[0] back to itself. The terminal *point* remains
 * derived and unselectable; that is a fact about the chart, not about the document.
 */
export function insertEntry(schedule: Schedule, args: InsertEntryArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice) return schedule;

  // An imported file can carry a voice with no entries at all (`warnings.ts` has a kind for it).
  // There is no segment to split, so the insert repairs it instead, at the length of the longest
  // voice — which is what the schedule would have played had this voice not zeroed it (§3.7).
  if (voice.entries.length === 0) {
    const duration = longestVoiceDuration(schedule) || NEW_VOICE_SECONDS;
    return replaceEntries(schedule, args.voice, () => [newEntry(voice.type, duration)]);
  }

  const index = Math.min(Math.max(0, Math.trunc(args.after)), voice.entries.length - 1);
  const starts = entryStartTimes(voice);
  const start = starts[index];
  const end = start + voice.entries[index].duration;
  const at = Math.min(Math.max(args.time ?? (start + end) / 2, start), end);

  const inserted: Entry = {
    ...valuesAt(voice, index, at),
    duration: end - at,
    preserved: {},
  };

  return replaceEntries(schedule, args.voice, (entries) => [
    ...entries.slice(0, index),
    { ...entries[index], duration: at - start },
    inserted,
    ...entries.slice(index + 1),
  ]);
}

export interface RemoveEntryArgs {
  voice: number;
  entry: number;
}

/**
 * Remove a breakpoint, giving its duration to the entry before it — or to the one after, when the
 * first entry goes.
 *
 * Length-preserving, so this is the exact inverse of `insertEntry` and the two round-trip. It
 * deliberately does **not** consult the squeeze/ripple control: that control reads "move everything
 * after the node too", which is a statement about dragging, and the round-trip is worth more than
 * the symmetry. Shortening a voice is what the duration field is for.
 *
 * **A voice may not be emptied.** Gnaural's reload groups entries into voices by the `parent`
 * attribute and takes each voice's properties by document order (`SG_RestoreBackupData`,
 * ScheduleGUI.c:2213), so a voice contributing no entry does not merely vanish — every voice after
 * it silently takes the wrong slot's description, type and flags. §6.3 requires the file to reopen
 * in Gnaural desktop, so this is refused rather than warned. It would also take `voiceDuration` to
 * zero and with it the whole schedule's length (§3.7).
 *
 * Removing entry 0 moves §3.5's wrap target, so the final segment now glides back to a different
 * pair of values. That is audible, unavoidable, and correct.
 */
export function removeEntry(schedule: Schedule, args: RemoveEntryArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice || voice.entries.length <= 1) return schedule;

  const index = args.entry;
  if (index < 0 || index >= voice.entries.length) return schedule;

  const absorbed = voice.entries[index].duration;
  const heir = index > 0 ? index - 1 : 1;

  return replaceEntries(schedule, args.voice, (entries) =>
    entries.flatMap((entry, at) => {
      if (at === index) return [];
      if (at === heir) return [{ ...entry, duration: entry.duration + absorbed }];
      return [entry];
    }),
  );
}

/**
 * The contiguous run of entries a selection moves, per voice.
 *
 * **The block runs from the lowest selected entry to the highest, and unselected entries in between
 * travel with it.** Moving only the selected ones would let a node pass a neighbour it was never
 * asked about, which reorders the voice; taking the whole run keeps the ordering and is explainable
 * in one sentence.
 *
 * **Entry 0 never moves in time** — its start is the sum of no durations — so a block that includes
 * it begins at entry 1 instead, and its own duration is what absorbs the shift. That is the same
 * rule `moveEntry` has enforced since step 5, applied to a run.
 */
interface Block {
  voice: number;
  first: number;
  last: number;
}

function blocksOf(schedule: Schedule, nodes: readonly EntryLocation[]): Block[] {
  const byVoice = new Map<number, { first: number; last: number }>();

  for (const node of nodes) {
    const voice = schedule.voices[node.voice];
    if (!voice || node.entry < 0 || node.entry >= voice.entries.length) continue;

    const current = byVoice.get(node.voice);
    if (!current) byVoice.set(node.voice, { first: node.entry, last: node.entry });
    else {
      current.first = Math.min(current.first, node.entry);
      current.last = Math.max(current.last, node.entry);
    }
  }

  return [...byVoice.entries()]
    .map(([voice, range]) => ({ voice, first: Math.max(1, range.first), last: range.last }))
    .filter((block) => block.first <= block.last);
}

export interface MoveEntriesArgs {
  nodes: readonly EntryLocation[];
  /** Seconds to shift by. Positive is later. */
  deltaTime: number;
  mode: MoveMode;
}

/**
 * Move a whole selection along the time axis — §6.1's "move a selection as a group".
 *
 * **One shift for every voice, clamped to what all of them allow.** Each voice's block can travel
 * only so far before it would give a neighbour a negative duration, and the intersection of those
 * ranges is what gets applied — so a group move can never silently desynchronise two voices by
 * moving one further than another. A selection that cannot move at all (every block pinned against
 * entry 0) returns the schedule unchanged.
 *
 * Squeeze gives the shift to the segment before each block and takes it back from the block's own
 * last segment, so every voice's length is unchanged and §3.7's spread survives. Ripple only feeds
 * the segment in front, so everything after the block slides and the voice gets longer or shorter —
 * which **can** make a schedule ragged, exactly as a single-node ripple has been able to since
 * step 5.
 */
export function moveEntries(schedule: Schedule, args: MoveEntriesArgs): Schedule {
  const blocks = blocksOf(schedule, args.nodes);
  if (blocks.length === 0) return schedule;

  let low = -Infinity;
  let high = Infinity;
  for (const block of blocks) {
    const entries = schedule.voices[block.voice].entries;
    low = Math.max(low, -entries[block.first - 1].duration);
    const trailing = entries[block.last];
    if (args.mode === 'squeeze' && block.last < entries.length - 1) {
      high = Math.min(high, trailing.duration);
    }
  }

  const delta = Math.min(Math.max(args.deltaTime, low), high);
  if (delta === 0 || !Number.isFinite(delta)) return schedule;

  return blocks.reduce(
    (next, block) =>
      replaceEntries(next, block.voice, (entries) =>
        entries.map((entry, index) => {
          if (index === block.first - 1) return { ...entry, duration: entry.duration + delta };
          if (index === block.last && args.mode === 'squeeze' && block.last < entries.length - 1) {
            return { ...entry, duration: entry.duration - delta };
          }
          return entry;
        }),
      ),
    schedule,
  );
}

export interface ScaleEntriesArgs {
  nodes: readonly EntryLocation[];
  /** Multiplier on the selection's own span. 1 changes nothing. */
  factor: number;
  mode: MoveMode;
}

/**
 * Stretch or compress a selection about its own start — §6.1's "scale a selection as a group".
 *
 * **This is not §6.1's "duration scaling" authoring aid, which is step 9's.** That one takes a whole
 * document to a target length, proportionally, across every voice so the §3.7 spread survives. This
 * is a factor over the selected run inside each voice, and the two coexist rather than overlap.
 *
 * The block's first node stays where it is and the durations inside it scale, so a block of one
 * node has no span and nothing to scale. What happens past the block is the mode's business again:
 * squeeze takes the difference out of the following segment (clamped at zero, so a compression
 * cannot be undone by an expansion that ran out of room), ripple lets everything after slide.
 */
export function scaleEntries(schedule: Schedule, args: ScaleEntriesArgs): Schedule {
  if (!(args.factor > 0)) return schedule;

  const blocks = blocksOf(schedule, args.nodes).filter((block) => block.last > block.first);
  if (blocks.length === 0) return schedule;

  return blocks.reduce((next, block) => {
    const entries = next.voices[block.voice].entries;
    const span = entries
      .slice(block.first, block.last)
      .reduce((total, entry) => total + entry.duration, 0);
    let growth = span * (args.factor - 1);

    const squeezing = args.mode === 'squeeze' && block.last < entries.length - 1;
    if (squeezing) growth = Math.min(growth, entries[block.last].duration);
    const factor = span > 0 ? (span + growth) / span : 1;
    if (factor === 1) return next;

    return replaceEntries(next, block.voice, (list) =>
      list.map((entry, index) => {
        if (index >= block.first && index < block.last) {
          return { ...entry, duration: entry.duration * factor };
        }
        if (index === block.last && squeezing) {
          return { ...entry, duration: entry.duration - growth };
        }
        return entry;
      }),
    );
  }, schedule);
}

export interface AdjustEntriesArgs {
  nodes: readonly EntryLocation[];
  field: EntryValueField;
  /** Added to every selected node's value, so the shape of the selection is preserved. */
  delta: number;
  min?: number;
  max?: number;
}

/**
 * Shift one value on every node of a selection by the same amount.
 *
 * A delta rather than an assignment: a group drag in a lane raises a curve without flattening it,
 * and "set all of these to 8 Hz" is a different intention that nothing has asked for. Clamping is
 * the caller's lane domain, so a drag cannot author a value it could not then see.
 */
export function adjustEntries(schedule: Schedule, args: AdjustEntriesArgs): Schedule {
  if (args.delta === 0) return schedule;

  const min = args.min ?? -Infinity;
  const max = args.max ?? Infinity;

  return args.nodes.reduce((next, node) => {
    const entry = next.voices[node.voice]?.entries[node.entry];
    if (!entry) return next;

    const value = Math.min(Math.max(entry[args.field] + args.delta, min), max);
    return updateEntry(next, node.voice, node.entry, { [args.field]: value });
  }, schedule);
}

/**
 * Delete a whole selection, by folding `removeEntry` over it from the highest index down.
 *
 * Deliberately a fold rather than a second implementation: it inherits step 6's absorb-the-duration
 * rule, its length preservation, and its hard floor of one entry per voice — which a group delete
 * meets by leaving the lowest-indexed node of a fully-selected voice standing rather than emptying
 * it. Descending order is what keeps the indices valid as the list shrinks under it.
 */
export function removeEntries(schedule: Schedule, nodes: readonly EntryLocation[]): Schedule {
  const ordered = [...nodes].sort((a, b) => b.voice - a.voice || b.entry - a.entry);
  return ordered.reduce((next, node) => removeEntry(next, node), schedule);
}

/**
 * A structural edit to the voice list, and the record of where each voice went.
 *
 * The value transforms all return a bare `Schedule` and this shape is the deliberate exception. A
 * map handed back separately — built by a sibling function the caller has to remember to pair with
 * the transform — is the one arrangement that can silently misalign the very gates the map exists
 * to keep aligned. Making it part of the return type means it cannot be forgotten.
 */
export interface VoiceEdit {
  schedule: Schedule;
  voiceMap: VoiceMap;
}

/** How long a voice gets when there is nothing to match: §1's "sessions run 15–60 minutes". */
export const NEW_VOICE_SECONDS = 1200;

/**
 * What a new voice is made of, taken off the corpus rather than invented.
 *
 * All 9 noise voices in the bundled library are `basefreq=100`, `beatfreq=0` and described
 * "Background noise". The tone values match `DEFAULT_LIVE_VALUES` — a test pins that, so the two
 * defaults cannot drift apart — and the volume sits just under the corpus tone median of 0.6, close
 * to `powernap`'s real 0.515. Deliberately not 1.0: dropping a new voice at full scale into a
 * programme already near it is the clipping case §5.3's null test had to be designed around.
 */
export type VoiceKind = 'tone' | 'noise';

const VOICE_DEFAULTS: Record<VoiceKind, { type: VoiceType } & Omit<Entry, 'duration' | 'preserved'>> = {
  tone: { type: VoiceType.Binaural, baseFreq: 200, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 },
  noise: { type: VoiceType.PinkNoise, baseFreq: 100, beatFreq: 0, volumeLeft: 0.4, volumeRight: 0.4 },
};

function newEntry(type: VoiceType, duration: number): Entry {
  const defaults = type === VoiceType.PinkNoise ? VOICE_DEFAULTS.noise : VOICE_DEFAULTS.tone;
  const { type: _unused, ...values } = defaults;
  return { ...values, duration, preserved: {} };
}

export interface InsertVoiceArgs {
  kind: VoiceKind;
  /** Where it lands. Appended by default. */
  at?: number;
}

/**
 * Add a voice, one entry long, spanning exactly the length the schedule already plays.
 *
 * **Matching `scheduleDuration` is what keeps this from being a §3.7 trap.** A shorter voice would
 * truncate the whole programme the moment it appeared, and a longer one would make it ragged; every
 * bundled file has a voice-duration spread of exactly zero, and adding a voice should not be what
 * ends that. It is also why §3.7's "pad to longest" does not have to arrive early.
 *
 * **One entry rather than two**, because one is the fewest the format accepts — `BB_CalibrateVoice`
 * wraps to entry 0 so a single point is a legal constant hold, and Gnaural's own guards reject
 * `TotalDataPoints < 1`, not 1 — the corpus contains such a voice, and `insertEntry` lands in the
 * same step, so it is not a dead end.
 *
 * **`id` is `max + 1` and nothing is ever renumbered.** Gnaural never reads `<id>` back at all
 * (there is no branch for it in `gxml_XMLParser`); what groups entries into voices on reload is the
 * `parent` attribute, treated as an opaque value that must simply *change* at each voice boundary.
 * So the only real requirement is that neighbours differ. Renumbering an existing voice would be
 * worse than pointless: its entries carry `preserved.parent`, which the serializer prefers, so the
 * id and the parent would silently disagree.
 */
export function insertVoice(schedule: Schedule, args: InsertVoiceArgs): VoiceEdit {
  const count = schedule.voices.length;
  const at = Math.min(Math.max(0, Math.trunc(args.at ?? count)), count);
  const { type } = VOICE_DEFAULTS[args.kind];
  const duration = scheduleDuration(schedule) || NEW_VOICE_SECONDS;

  const voice: Voice = {
    id: count > 0 ? Math.max(...schedule.voices.map((existing) => existing.id)) + 1 : 0,
    description: args.kind === 'noise' ? 'Background noise' : `Voice ${at + 1}`,
    type,
    muted: false,
    hidden: false,
    mono: false,
    // No `preserved`: a new entry has no unrecognised data, and the serializer then derives its
    // `parent` from the owning voice's id — the fallback path that has never had a real caller
    // until now. `state` is safely absent (Gnaural `calloc`s its datapoints, so it reads as the 0
    // all 354 corpus entries carry); `parent` is not, which is what makes that fallback
    // load-bearing rather than decorative.
    entries: [newEntry(type, duration)],
    preserved: {},
  };

  const voices = [...schedule.voices.slice(0, at), voice, ...schedule.voices.slice(at)];
  return { schedule: { ...schedule, voices }, voiceMap: insertVoiceMap(count, at) };
}

/**
 * Delete a voice, including the last one.
 *
 * A schedule with no voices is an accepted state rather than a refused one: 9a already warns for it
 * and already disables Play, an imported file can already be one, and with fork-to-draft as the only
 * way into the editor it is the closest thing this app offers to §6.3's "authored from scratch".
 * The voice list says so on the spot.
 */
export function removeVoice(schedule: Schedule, index: number): VoiceEdit {
  const count = schedule.voices.length;
  if (index < 0 || index >= count) {
    return { schedule, voiceMap: identityVoiceMap(count) };
  }

  const voices = schedule.voices.filter((_voice, at) => at !== index);
  return { schedule: { ...schedule, voices }, voiceMap: removeVoiceMap(count, index) };
}

export interface MoveVoiceArgs {
  from: number;
  to: number;
}

/**
 * Reorder the voice list.
 *
 * **This is the case the index map exists for.** `requiresVoiceRebuild` only fires on voice count,
 * `type` and `mono`, so reordering two voices alike in both takes the engine's *value* path: the
 * compiled curves swap between oscillators that keep their phase, which is exactly right. What does
 * not follow them is the session mute/solo gate, which is keyed by slot — so without the map,
 * soloing a voice and then moving it silences a different one.
 */
export function moveVoice(schedule: Schedule, args: MoveVoiceArgs): VoiceEdit {
  const count = schedule.voices.length;
  const from = args.from;
  const to = Math.min(Math.max(0, args.to), count - 1);
  if (from < 0 || from >= count || from === to) {
    return { schedule, voiceMap: identityVoiceMap(count) };
  }

  const voices = [...schedule.voices];
  const [moved] = voices.splice(from, 1);
  voices.splice(to, 0, moved);

  return { schedule: { ...schedule, voices }, voiceMap: moveVoiceMap(count, from, to) };
}

/**
 * The value of every entry field at `at`, on the segment beginning at `index`.
 *
 * §3.5 applied to the document rather than to a compiled curve, so the document layer keeps no
 * dependency on the engine. The `next` entry wraps to entry[0] on the final segment, which is the
 * same unconditional rule `compileVoice` implements — `edit.test.ts` asserts the two agree, since
 * this being a second statement of §3.5 is the one risk in writing it here.
 */
function valuesAt(voice: Voice, index: number, at: number): Omit<Entry, 'duration' | 'preserved'> {
  const entry = voice.entries[index];
  const next = voice.entries[index + 1] ?? voice.entries[0];
  const start = entryStartTimes(voice)[index];
  const factor = entry.duration > 0 ? (at - start) / entry.duration : 0;

  const between = (from: number, to: number) => from + (to - from) * factor;
  return {
    baseFreq: between(entry.baseFreq, next.baseFreq),
    beatFreq: between(entry.beatFreq, next.beatFreq),
    volumeLeft: between(entry.volumeLeft, next.volumeLeft),
    volumeRight: between(entry.volumeRight, next.volumeRight),
  };
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
