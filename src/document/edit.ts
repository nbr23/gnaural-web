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

// Pure edit transforms: (schedule, args) => Schedule. Untouched values keep their identity (cheap
// undo snapshots) and a no-op returns the same object (no spurious undo step).

/** Patch rather than a setter, so the undo commit's name belongs to the caller, not the function. */
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

/** Every `<entry/>` field except `preserved`, which is never patched — unrecognised data round-trips verbatim. */
export type EntryPatch = Partial<
  Pick<Entry, 'duration' | 'baseFreq' | 'beatFreq' | 'volumeLeft' | 'volumeRight'>
>;

/** The entry fields drawn on a lane's curve. `duration` is excluded — it's the x-axis, not a lane value. */
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
 * Squeeze is the default and ripple the modifier: rippling changes a voice's total length, which
 * changes the schedule's playback length (set by its shortest voice) and can raise a ragged-schedule
 * warning on the user's own drag.
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
 * Entry 0 cannot move (its start is zero by definition). The last entry always ripples regardless of
 * mode, since it has no following segment to squeeze into. Both modes clamp at zero duration rather
 * than letting a node pass its neighbour.
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

/** Voice fields the editor's voice list can change. `id` is absent — nothing may renumber a voice (see `insertVoice`). */
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
 * Add a breakpoint by splitting a segment, with values interpolated off the existing curve — so the
 * insert is audibly a no-op, and voice length is unchanged. The final segment (the wrap back to
 * entry[0]) needs no special case: it splits like any other, including for a one-entry voice.
 */
export function insertEntry(schedule: Schedule, args: InsertEntryArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice) return schedule;

  // An empty imported voice has no segment to split, so repair it instead at the longest voice's
  // length — what the schedule would have played had this voice not zeroed it.
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
 * first entry goes. Length-preserving, so this is the exact inverse of `insertEntry`.
 *
 * A voice may not be emptied: Gnaural groups entries into voices by the `parent` attribute on
 * reload, so an empty voice doesn't just vanish — every later voice silently inherits the wrong
 * slot's description, type and flags.
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
 * The contiguous run of entries a selection moves, per voice: lowest selected entry to highest, with
 * unselected entries in between carried along so ordering is preserved. A block including entry 0
 * begins at entry 1 instead, since entry 0 never moves in time.
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
 * Move a whole selection along the time axis, as one group.
 *
 * One shift is applied to every voice, clamped to what all of them allow — the intersection of each
 * voice's range keeps a group move from silently desynchronising two voices. Squeeze preserves each
 * voice's length; ripple can make a schedule ragged, same as a single-node ripple.
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
 * Stretch or compress a selection about its own start (distinct from `setScheduleLength`, which
 * scales the whole document proportionally). The block's first node stays put; durations inside it
 * scale. Squeeze takes the difference from the following segment (clamped at zero); ripple lets
 * everything after slide.
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

/** Shift one value on every node of a selection by the same delta, preserving the curve's shape. */
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
 * Delete a whole selection, by folding `removeEntry` over it from the highest index down so indices
 * stay valid as the list shrinks. Inherits `removeEntry`'s floor of one entry per voice.
 */
export function removeEntries(schedule: Schedule, nodes: readonly EntryLocation[]): Schedule {
  const ordered = [...nodes].sort((a, b) => b.voice - a.voice || b.entry - a.entry);
  return ordered.reduce((next, node) => removeEntry(next, node), schedule);
}

/** A structural edit to the voice list, plus the record of where each voice went. */
export interface VoiceEdit {
  schedule: Schedule;
  voiceMap: VoiceMap;
}

/** How long a voice gets when there is nothing to match: sessions run 15–60 minutes. */
export const NEW_VOICE_SECONDS = 1200;

/**
 * Defaults for a new voice, taken from the bundled corpus rather than invented. Volume is 0.5 rather
 * than 1.0 — full scale on a voice added to an already-loud programme is the clipping case a null
 * test had to guard against. `water`/`rain` values are measured from Gnaural's own voice-creation
 * code, since `basefreq`/`beatfreq` mean a probability and a drop count for those, not a tone.
 */
export type VoiceKind = 'tone' | 'isochronic' | 'noise' | 'water' | 'rain';

const VOICE_DEFAULTS: Record<VoiceKind, { type: VoiceType } & Omit<Entry, 'duration' | 'preserved'>> = {
  tone: { type: VoiceType.Binaural, baseFreq: 200, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 },
  isochronic: { type: VoiceType.IsoPulse, baseFreq: 200, beatFreq: 10, volumeLeft: 0.5, volumeRight: 0.5 },
  noise: { type: VoiceType.PinkNoise, baseFreq: 100, beatFreq: 0, volumeLeft: 0.4, volumeRight: 0.4 },
  water: {
    type: VoiceType.WaterDrops,
    baseFreq: 0.000352858,
    beatFreq: 2,
    volumeLeft: 0.5,
    volumeRight: 0.5,
  },
  rain: { type: VoiceType.Rain, baseFreq: 0.1, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5 },
};

/** What each kind of voice is called when nobody has named it. A tone voice takes its position instead. */
const VOICE_DESCRIPTIONS: Record<VoiceKind, string | null> = {
  tone: null,
  isochronic: 'Isochronic pulse',
  noise: 'Background noise',
  water: 'Water drops',
  rain: 'Rain',
};

function newEntry(kind: VoiceKind, duration: number): Entry {
  const { type: _unused, ...values } = VOICE_DEFAULTS[kind];
  return { ...values, duration, preserved: {} };
}

/**
 * Which set of defaults an existing voice's entries should be made from, when a node is added to an
 * existing voice. Types 5 and 6 (water/rain) must map explicitly rather than fall back to `tone`: a
 * `basefreq` of 200 there is a probability of 200 — the loudest thing the generator can make, not a
 * harmless default.
 */
export function voiceKindOf(type: VoiceType): VoiceKind {
  if (type === VoiceType.PinkNoise) return 'noise';
  if (type === VoiceType.IsoPulse || type === VoiceType.IsoPulseAlt) return 'isochronic';
  if (type === VoiceType.WaterDrops) return 'water';
  if (type === VoiceType.Rain) return 'rain';
  return 'tone';
}

export interface InsertVoiceArgs {
  kind: VoiceKind;
  /** Where it lands. Appended by default. */
  at?: number;
  /** The voice's contents, for a generator. One default entry when absent. */
  entries?: readonly Entry[];
  /** What to call it. The kind's own default when absent. */
  description?: string;
}

/**
 * Add a voice, one entry long, spanning exactly the length the schedule already plays — matching
 * `scheduleDuration` rather than truncating or making the schedule ragged. One entry is the fewest
 * the format accepts. `id` is `max + 1`; ids are never renumbered, since Gnaural groups entries into
 * voices by the `parent` attribute on reload, not by id.
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
    // No `preserved`: a new entry has no unrecognised data, so the serializer derives its `parent`
    // from the owning voice's id.
    entries: args.entries && args.entries.length > 0 ? [...args.entries] : [newEntry(args.kind, duration)],
    preserved: {},
  };

  const voices = [...schedule.voices.slice(0, at), voice, ...schedule.voices.slice(at)];
  return { schedule: { ...schedule, voices }, voiceMap: insertVoiceMap(count, at) };
}

/**
 * A document to start from: one tone voice, twenty minutes long, and nothing else. Built via
 * `insertVoice` on an empty schedule rather than a hand-written literal, so a blank program is
 * exactly what "Add a voice" would have produced. Master volumes are 1/1, matching the parser's
 * default for a file with no `overallvolume_*`.
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

/** Delete a voice, including the last one — a schedule with no voices is an accepted state, not a refused one. */
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
 * Reorder the voice list. This is the case the voice map exists for: reordering doesn't trigger an
 * engine rebuild, but the session mute/solo gate is keyed by slot index, so without the map soloing
 * a voice and then moving it would silence a different one.
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
 * Copy a voice, entries and all. The copy's entries must give up their stored `preserved.parent`:
 * kept intact, a copy placed next to its source would share the same owner and Gnaural would merge
 * them back into one voice on reopen. Dropping it lets the serializer derive `parent` from the
 * copy's own id instead. The copy lands directly after its source.
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
 * Play a voice backwards. A voice is a closed curve (the final segment always glides back to
 * entry[0]'s values), so reversing what's heard means r(t) = v(T − t): entry 0 keeps its values,
 * every later entry takes its mirror image's values, and durations reverse wholesale. Simply
 * reversing the entry array would produce a different, wrong curve.
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

export interface TransposeVoiceArgs {
  voice: number;
  /** Added to every node's base frequency. Negative shifts the voice down. */
  delta: number;
}

/**
 * Retune a whole voice, keeping the shape of its base curve: every node moves by the same delta, so
 * a glide from 438 to 434 Hz stays a 4 Hz glide wherever it lands.
 *
 * The delta itself is clamped so the lowest node stops at 0 Hz, rather than clamping each node —
 * a per-node floor would flatten the curve against it. Values outside the audible range are not
 * refused: `warnings.ts` already reports a carrier too low or too high, on the node it happened on.
 */
export function transposeVoice(schedule: Schedule, args: TransposeVoiceArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice || voice.entries.length === 0 || !Number.isFinite(args.delta)) return schedule;

  const lowest = Math.min(...voice.entries.map((entry) => entry.baseFreq));
  const delta = Math.max(args.delta, -lowest);
  if (delta === 0) return schedule;

  const nodes = voice.entries.map((_entry, entry) => ({ voice: args.voice, entry }));
  return adjustEntries(schedule, { nodes, field: 'baseFreq', delta });
}

export interface OffsetVoiceArgs {
  voice: number;
  /** Seconds to move the voice later. Negative moves it earlier. */
  seconds: number;
}

/**
 * Shift a voice in time. The format has no per-voice start offset, so this rewrites the entries as a
 * rotation of the voice's closed curve: the value at `T − s` becomes the value at 0. Voice length is
 * unchanged, and offsetting by `−s` afterwards restores the original curve. At most one breakpoint
 * is added, where the rotation lands mid-segment.
 */
export function offsetVoice(schedule: Schedule, args: OffsetVoiceArgs): Schedule {
  const voice = schedule.voices[args.voice];
  if (!voice || voice.entries.length === 0 || !Number.isFinite(args.seconds)) return schedule;

  const total = voiceDuration(voice);
  if (!(total > 0)) return schedule;

  const from = (((-args.seconds % total) + total) % total) || 0;
  if (from === 0) return schedule;

  const starts = entryStartTimes(voice);
  const index = starts.findLastIndex((start) => start <= from);
  const entries = voice.entries;

  // Landing exactly on a breakpoint needs no new node.
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
 * One-click "pad to longest": bring every short voice up to the length of the longest, so the
 * shortest voice stops cutting the whole programme off. The shortfall goes onto the last entry's
 * duration, matching Gnaural's own truncate-schedule behaviour. A voice with no entries is skipped —
 * there's no segment to stretch.
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
 * Stretch or compress the entire program to a target length, proportionally — distinct from
 * `scaleEntries`, which scales one selected run inside one voice. One factor is applied to every
 * duration in every voice, so the ratio between voices is preserved. The target is measured against
 * `scheduleDuration` (the shortest voice), which is what actually plays.
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
 * The repair for the `gnaural-regroup` warning: make each voice's entries name that voice, and only
 * that voice. Gnaural rebuilds voices from the entries' `parent` attribute alone on reload, so
 * disagreement (two adjacent voices sharing a parent, or one voice carrying two) reopens as
 * something other than what was saved. The fix is to renumber ids and let the serializer derive
 * `parent` from them. Cannot repair a voice with no entries — see `warnings.ts`.
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
 * Whether this document's voices come back as themselves on reload — one owner per voice, different
 * from the voice before it. A voice with no entries is passed over; `warnings.ts` must read this
 * boundary the same way.
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
 * The value of every entry field at `at`, on the segment beginning at `index`. Mirrors the
 * document layer's own curve model rather than depending on the engine's compiled one; the `next`
 * entry wraps to entry[0] on the final segment, matching `compileVoice`.
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
