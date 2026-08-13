import { entryParent } from './serializer';
import {
  DURATION_EPSILON,
  entryStartTimes,
  longestVoiceDuration,
  scheduleDuration,
  voiceDuration,
} from './timing';
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
 * The voice fields §6.1 asks the editor's voice list for.
 *
 * `type` was absent until step 10 on the grounds that a patch field with no caller is a capability
 * nobody can exercise; the isochronic pair supplied one, since types 3 and 4 differ only in which
 * ear each pulse lands in and switching between them is a toggle rather than a new voice. `mono`
 * still has no control. `id` is absent because nothing may renumber a voice — see `insertVoice`.
 */
export type VoicePatch = Partial<Pick<Voice, 'description' | 'muted' | 'hidden' | 'type'>>;

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
    return replaceEntries(schedule, args.voice, () => [newEntry(voiceKindOf(voice.type), duration)]);
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
 *
 * **`isochronic` is the one row with no corpus behind it**, since no bundled file uses any type
 * 2–6 — so it is a decision rather than a measurement. It takes the tone row's numbers unchanged,
 * because the two fields mean the same two things for it (a carrier, and a rate); a different set
 * would be asserting a difference that is not there. The same test pins all three together.
 *
 * The offered kinds are deliberately not every renderable type: type 4 differs from type 3 only in
 * which ear each pulse lands in, which is a toggle on a voice rather than a separate thing to add.
 */
export type VoiceKind = 'tone' | 'isochronic' | 'noise';

const VOICE_DEFAULTS: Record<VoiceKind, { type: VoiceType } & Omit<Entry, 'duration' | 'preserved'>> = {
  tone: { type: VoiceType.Binaural, baseFreq: 200, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 },
  isochronic: { type: VoiceType.IsoPulse, baseFreq: 200, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 },
  noise: { type: VoiceType.PinkNoise, baseFreq: 100, beatFreq: 0, volumeLeft: 0.4, volumeRight: 0.4 },
};

/** What each kind of voice is called when nobody has named it. */
const VOICE_DESCRIPTIONS: Record<VoiceKind, string | null> = {
  // A tone voice takes its position instead, which is what the corpus does.
  tone: null,
  isochronic: 'Isochronic pulse',
  noise: 'Background noise',
};

function newEntry(kind: VoiceKind, duration: number): Entry {
  const { type: _unused, ...values } = VOICE_DEFAULTS[kind];
  return { ...values, duration, preserved: {} };
}

/**
 * Which set of defaults an existing voice's entries should be made from — needed when a voice
 * exists already and a *node* is being added to it. Every type this app does not offer as a kind
 * falls back to `tone`, which reads both fields the way the file most likely intends.
 */
export function voiceKindOf(type: VoiceType): VoiceKind {
  if (type === VoiceType.PinkNoise) return 'noise';
  if (type === VoiceType.IsoPulse || type === VoiceType.IsoPulseAlt) return 'isochronic';
  return 'tone';
}

export interface InsertVoiceArgs {
  kind: VoiceKind;
  /** Where it lands. Appended by default. */
  at?: number;
  /**
   * The voice's contents, for a generator (§6.1). One default entry when absent.
   *
   * Generators write into a **new** voice rather than over an existing one, so they come through
   * here rather than growing a transform of their own: `id = max + 1`, the empty `preserved` that
   * makes the serializer derive `parent`, and the voice map are all decided in one place, and a
   * generated voice is the same kind of voice as an added one.
   */
  entries?: readonly Entry[];
  /** What to call it. The kind's own default when absent. */
  description?: string;
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
    id: nextVoiceId(schedule),
    description: args.description ?? VOICE_DESCRIPTIONS[args.kind] ?? `Voice ${at + 1}`,
    type,
    muted: false,
    hidden: false,
    mono: false,
    // No `preserved`: a new entry has no unrecognised data, and the serializer then derives its
    // `parent` from the owning voice's id — the fallback path that has never had a real caller
    // until now. `state` is safely absent (Gnaural `calloc`s its datapoints, so it reads as the 0
    // all 354 corpus entries carry); `parent` is not, which is what makes that fallback
    // load-bearing rather than decorative.
    entries: args.entries && args.entries.length > 0 ? [...args.entries] : [newEntry(args.kind, duration)],
    preserved: {},
  };

  const voices = [...schedule.voices.slice(0, at), voice, ...schedule.voices.slice(at)];
  return { schedule: { ...schedule, voices }, voiceMap: insertVoiceMap(count, at) };
}

/**
 * A document to start from: one tone voice, twenty minutes long, and nothing else.
 *
 * §6.3 asks that a schedule can be authored *from scratch*, and until now the only way into the
 * editor was to fork something that already existed. This is the missing beginning, and it is
 * deliberately `insertVoice` on an empty schedule rather than a hand-written literal: the defaults
 * a new voice gets, its id, its `preserved` and its length are decided in one place, and a blank
 * program is then the same document "Add a voice" would have produced.
 *
 * The master volumes are 1/1, matching what the parser defaults a file with no `overallvolume_*`
 * to, so a new program and an old file that says nothing about its mix mean the same thing.
 */
export function newSchedule(title: string): Schedule {
  const empty: Schedule = {
    title,
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [],
    preserved: {},
  };

  return insertVoice(empty, { kind: 'tone' }).schedule;
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
 * Copy a voice, entries and all — §6.1's "duplicate voice".
 *
 * **The copy's entries must give up their stored owner, and that is the whole subtlety.** The
 * serializer prefers `entry.preserved.parent` over the voice's id, and all 51 corpus voices carry
 * one; a copy placed next to its source with those parents intact is exactly the *merge* shape step
 * 7's `gnaural-regroup` warns about — Gnaural starts a new voice only where `parent` changes, so the
 * two would come back as one. Dropping it lets the serializer derive `parent` from the new id, which
 * differs from every other voice's, and the copy survives a round trip through Gnaural desktop.
 *
 * The copy lands **directly after its source**, which is where the eye expects it and which the
 * positional palette then colours as a neighbour. (Gnaural's own `SG_DuplicateSelectedVoice`,
 * ScheduleGUI.c:4210, appends to the end; adjacency is only safe here *because* of the strip above,
 * which is why that is the line to keep.) Everything else is copied as Gnaural copies it —
 * description, type, mute and mono — plus `hidden` and the voice's own preserved fields, which are
 * this format's and not that function's to know about.
 */
export function duplicateVoice(schedule: Schedule, index: number): VoiceEdit {
  const count = schedule.voices.length;
  const source = schedule.voices[index];
  if (!source) return { schedule, voiceMap: identityVoiceMap(count) };

  const at = index + 1;
  const copy: Voice = {
    ...source,
    id: nextVoiceId(schedule),
    description: `${source.description.trim() || `Voice ${index + 1}`} copy`,
    entries: source.entries.map(withoutParent),
  };

  const voices = [...schedule.voices.slice(0, at), copy, ...schedule.voices.slice(at)];
  return { schedule: { ...schedule, voices }, voiceMap: insertVoiceMap(count, at) };
}

/**
 * Play a voice backwards — §6.1's "reverse a voice".
 *
 * **§3.5 makes a voice a closed curve, and that is what a correct reversal has to respect.** The
 * final segment glides back to entry[0]'s values whether or not the schedule loops, so `v(0)` and
 * `v(T)` are the same value and the curve is a loop rather than a line. Reversing what is *heard*
 * therefore means `r(t) = v(T − t)`, which lands on: entry 0 keeps its values, every later entry
 * takes the values of its mirror image, and **the duration list reverses wholesale**. Simply
 * reversing the entry array would instead move entry[0]'s values to the end, where §3.5 would put
 * them back at the front anyway — a different curve, and not the one that was asked for.
 *
 * The reference agrees, arrived at from the other side: `SG_ReverseVoice` (ScheduleGUI.c:4286) leaves
 * the first datapoint alone, mirrors every later point's x about the width of the plot, and reverses
 * the rest of the list. Length is preserved exactly and reversing twice is the original.
 */
export function reverseVoice(schedule: Schedule, index: number): Schedule {
  const voice = schedule.voices[index];
  if (!voice || voice.entries.length < 2) return schedule;

  const entries = voice.entries;
  const last = entries.length - 1;
  const reversed = entries.map((_entry, position) => ({
    ...entries[position === 0 ? 0 : entries.length - position],
    duration: entries[last - position].duration,
  }));

  if (reversed.every((entry, position) => sameEntry(entry, entries[position]))) return schedule;
  return replaceEntries(schedule, index, () => reversed);
}

export interface OffsetVoiceArgs {
  voice: number;
  /** Seconds to move the voice later. Negative moves it earlier. */
  seconds: number;
}

/**
 * Shift a voice in time — §6.1's "offset a voice in time".
 *
 * **The format cannot express a start offset**: every voice begins at t=0 and there is no per-voice
 * start field, so an offset has to be a rewrite of the entries. §3.5 decides which rewrite. Because
 * the final segment glides back to entry[0] unconditionally, a voice is a *cycle*, and moving a cycle
 * later is a rotation of it: the value that was at `T − s` becomes the value at 0, and everything
 * follows round. Nothing is lost, the voice's length is unchanged so §3.7's spread survives, and
 * offsetting by `−s` afterwards is the original curve again.
 *
 * The alternative — prepending a lead-in hold — was rejected for what it costs: the voice grows by
 * `s`, which makes the schedule ragged on the user's own command, or else the tail is thrown away.
 *
 * At most one breakpoint is added, where the rotation lands mid-segment. It is audibly a no-op, for
 * the same reason `insertEntry` is: the value it carries is the value the curve already had there.
 */
export function offsetVoice(schedule: Schedule, args: OffsetVoiceArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice || voice.entries.length === 0 || !Number.isFinite(args.seconds)) return schedule;

  const total = voiceDuration(voice);
  if (!(total > 0)) return schedule;

  // The point in the original curve that becomes the new beginning: r(t) = v(t − s), so r(0) = v(−s).
  const from = (((-args.seconds % total) + total) % total) || 0;
  if (from === 0) return schedule;

  const starts = entryStartTimes(voice);
  const index = starts.findLastIndex((start) => start <= from);
  const entries = voice.entries;

  // Landing exactly on a breakpoint is the case that needs no new node — rare with a typed offset,
  // and the common case for a voice whose nodes are round numbers.
  if (starts[index] === from) {
    return replaceEntries(schedule, args.voice, () => [
      ...entries.slice(index),
      ...entries.slice(0, index),
    ]);
  }

  const head = { ...entries[index], duration: from - starts[index] };
  const tail: Entry = {
    ...valuesAt(voice, index, from),
    duration: starts[index] + entries[index].duration - from,
    preserved: {},
  };

  return replaceEntries(schedule, args.voice, () => [
    tail,
    ...entries.slice(index + 1),
    ...entries.slice(0, index),
    head,
  ]);
}

/**
 * §3.7's one-click "pad to longest": bring every short voice up to the length of the longest, so the
 * shortest stops cutting the whole programme off.
 *
 * **The shortfall goes onto the last entry's duration**, which is what Gnaural itself does when its
 * `SG_TruncateSchedule` (ScheduleGUI.c:4343) is given an end time beyond a voice's own: *"lengthen
 * the last DP to fit schedule"*. In §3.5's terms the voice's glide home takes longer; nothing is
 * added, nothing is thrown away, and the entry count does not move.
 *
 * A voice with no entries is skipped — there is no segment to stretch, and its own repair is to be
 * given a node or deleted. Voices already within `DURATION_EPSILON` of the longest are left exactly
 * as they are, so this touches only what the warning is actually about.
 */
export function padVoicesToLongest(schedule: Schedule): Schedule {
  const longest = longestVoiceDuration(schedule);
  if (!(longest > 0)) return schedule;

  let padded = false;
  const voices = schedule.voices.map((voice) => {
    if (voice.entries.length === 0) return voice;

    const shortfall = longest - voiceDuration(voice);
    if (shortfall <= DURATION_EPSILON) return voice;

    padded = true;
    const last = voice.entries.length - 1;
    return {
      ...voice,
      entries: voice.entries.map((entry, index) =>
        index === last ? { ...entry, duration: entry.duration + shortfall } : entry,
      ),
    };
  });

  return padded ? { ...schedule, voices } : schedule;
}

/**
 * §6.1's "duration scaling — stretch or compress an entire program to a target length,
 * proportionally".
 *
 * **Not step 8's group scale**, which multiplies the durations inside one selected run of one voice.
 * This is the whole document against a target length: one factor, every duration in every voice, so
 * the ratio between two voices — and therefore §3.7's spread, whatever it is — comes through
 * unchanged. It is also the only transform in this file that rebuilds every entry, which is what
 * makes it the history stack's worst snapshot (~13 kB on the densest bundled document).
 *
 * The target is measured against `scheduleDuration` — the shortest voice, which is what actually
 * plays and what the timeline, the library card and the export all report — so "make this twenty
 * minutes" means the programme runs for twenty minutes.
 */
export function setScheduleLength(schedule: Schedule, seconds: number): Schedule {
  const current = scheduleDuration(schedule);
  if (!(current > 0) || !(seconds > 0) || !Number.isFinite(seconds)) return schedule;

  const factor = seconds / current;
  if (factor === 1) return schedule;

  const voices = schedule.voices.map((voice) =>
    voice.entries.length === 0
      ? voice
      : {
          ...voice,
          entries: voice.entries.map((entry) => ({ ...entry, duration: entry.duration * factor })),
        },
  );
  return { ...schedule, voices };
}

/**
 * The repair for step 7's `gnaural-regroup`: make each voice's entries name that voice, and only
 * that voice.
 *
 * **Gnaural rebuilds its voices from the entries alone.** `SG_RestoreBackupData` (ScheduleGUI.c:2213)
 * walks the flat datapoint list in document order and starts a new voice wherever an entry's `parent`
 * differs from the previous entry's, then takes each voice's description, type and flags by position;
 * `<id>` is never read back at all. So a document whose entries disagree with their voice — two
 * adjacent voices sharing a parent, or one voice carrying two — reopens as something other than what
 * was saved, and the fix is to renumber the ids and let the serializer derive `parent` from them.
 *
 * **It reads `entryParent`**, the same one line the detection in `warnings.ts` reads and the
 * serializer writes through, so the check, the repair and the file can never come to disagree.
 *
 * **It cannot repair the third shape**, a voice with no entries: that voice contributes no datapoint
 * whatever its id, so it disappears on reopen and shifts every later voice's identity. Giving it a
 * node or deleting it are the only answers, and both are already commands. The warning stays up, and
 * the caller offers this repair only when it would change something.
 */
export function repairVoiceGrouping(schedule: Schedule): Schedule {
  if (groupingSurvivesGnaural(schedule)) return schedule;

  const voices = schedule.voices.map((voice, index) => {
    const entries = voice.entries.map(withoutParent);
    const untouched =
      voice.id === index && entries.every((entry, at) => entry === voice.entries[at]);
    return untouched ? voice : { ...voice, id: index, entries };
  });

  return { ...schedule, voices };
}

/**
 * Whether this document's voices come back as themselves — one owner per voice, and a different one
 * from the voice before it.
 *
 * A voice with no entries is passed over rather than judged: it has no owner to compare, it raises
 * its own warning, and this repair cannot help it. That is also exactly how `warnings.ts` reads the
 * boundary, which is the point — the two must agree about what is broken.
 */
function groupingSurvivesGnaural(schedule: Schedule): boolean {
  let previous: string | null = null;

  for (const voice of schedule.voices) {
    if (voice.entries.length === 0) {
      previous = null;
      continue;
    }

    const owners = new Set(voice.entries.map((entry) => entryParent(entry, voice.id)));
    if (owners.size > 1) return false;

    const [owner] = owners;
    if (owner === previous) return false;
    previous = owner;
  }

  return true;
}

/** The lowest id no voice is using. Nothing is ever renumbered — see `insertVoice`. */
function nextVoiceId(schedule: Schedule): number {
  return schedule.voices.length > 0
    ? Math.max(...schedule.voices.map((voice) => voice.id)) + 1
    : 0;
}

/**
 * An entry that no longer names an owner, so the serializer derives one from the voice it is in.
 *
 * Returns the entry itself when there is nothing to drop, which is what keeps a repair from
 * rebuilding entries it has no business rebuilding.
 */
function withoutParent(entry: Entry): Entry {
  if (!('parent' in entry.preserved)) return entry;
  const { parent: _dropped, ...preserved } = entry.preserved;
  return { ...entry, preserved };
}

/** Field equality, for transforms that can rearrange a voice into exactly what it already was. */
function sameEntry(a: Entry, b: Entry): boolean {
  return (
    a.duration === b.duration &&
    a.baseFreq === b.baseFreq &&
    a.beatFreq === b.beatFreq &&
    a.volumeLeft === b.volumeLeft &&
    a.volumeRight === b.volumeRight &&
    a.preserved === b.preserved
  );
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
