import { entryParent } from './serializer';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from './timing';
import type { Entry, EntryLocation, Schedule, Voice } from './types';
import { VoiceType, isRenderableType, isTonalType } from './types';

/**
 * Everything a file does that the listener should be told about.
 *
 * Three producers, one type. `parseScheduleWithWarnings` reports what was wrong with the *file* —
 * stale declared counts, values that would not parse, reused voice ids — since that information is
 * gone once the XML has become a `Schedule`. `scheduleWarnings` reports what's wrong with the
 * *program* — unrenderable voice types, unequal voice lengths — a property of the model alone.
 * `entryWarnings` is the editor's inline validation, and the only one whose warnings carry a
 * location.
 *
 * Severity: a `warning` means what you hear will differ from what the file describes; a `notice`
 * means the file was unusual and was handled correctly.
 *
 * Warnings are deliberately not stored on `Schedule` — the document stays immutable and
 * reference-compared, which undo/redo depends on.
 */
export type WarningSeverity = 'warning' | 'notice';

export interface ScheduleWarning {
  severity: WarningSeverity;
  /** Stable discriminator — what tests assert on, and what dedupes repeats across voices. */
  kind: WarningKind;
  message: string;
}

export type WarningKind =
  // Model-derived
  | 'pcm-voice'
  | 'unsupported-voice'
  | 'unequal-durations'
  | 'nothing-to-play'
  // File-derived
  | 'stale-count'
  | 'duplicate-voice-id'
  | 'unparseable-value'
  | 'empty-voice'
  // Value-derived, and locatable
  | 'negative-duration'
  | 'base-too-low'
  | 'base-too-high'
  | 'beat-above-band'
  | 'beat-exceeds-base'
  | 'volume-out-of-range'
  | 'gnaural-regroup';

/** Names for the types this file has something to say about — just PCM now that 5 and 6 are rendered too. */
const TYPE_NAMES: Record<number, string> = {
  [VoiceType.Pcm]: 'external audio',
};

function voiceLabel(voice: Voice, index: number): string {
  return voice.description.trim() || `voice ${index + 1}`;
}

function list(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What this program will do that its file does not say — derived from the model alone, so it holds
 * for a schedule that arrived through a share link as much as one read off disk.
 */
export function scheduleWarnings(schedule: Schedule): ScheduleWarning[] {
  const warnings: ScheduleWarning[] = [];

  // PCM gets its own message: the audio lives in an external file whose path the schedule doesn't
  // record, so it's unsupportable from a schedule alone, not "not yet" supported.
  const pcm = schedule.voices.filter((voice) => voice.type === VoiceType.Pcm);
  if (pcm.length > 0) {
    const subject = describeVoices(schedule, pcm);
    warnings.push({
      severity: 'warning',
      kind: 'pcm-voice',
      message: `${subject.text} ${subject.verb('play')} an external audio file. The Gnaural format does not record where that file is, so this can never be played from the schedule alone — ${subject.plural ? 'they' : 'it'} will be silent.`,
    });
  }

  // What's left is a type number no version of Gnaural ever wrote — a dirty file the parser kept
  // verbatim rather than correcting. The `type N` fallback below is for exactly that voice.
  const unsupported = schedule.voices.filter(
    (voice) => !isRenderableType(voice.type) && voice.type !== VoiceType.Pcm,
  );
  if (unsupported.length > 0) {
    const subject = describeVoices(schedule, unsupported);
    const kinds = [...new Set(unsupported.map((voice) => TYPE_NAMES[voice.type] ?? `type ${voice.type}`))];
    const it = subject.plural ? 'they are' : 'it is';
    warnings.push({
      severity: 'warning',
      kind: 'unsupported-voice',
      message: `${subject.text} ${subject.verb('use')} a voice type Gnaural Web does not render yet (${list(kinds)}). ${it[0].toUpperCase()}${it.slice(1)} kept intact and will export unchanged, but ${it} silent here.`,
    });
  }

  // The shortest voice ends the schedule for every voice, so a ragged file loses the tail of
  // everything longer.
  const durations = schedule.voices.map(voiceDuration);
  const playback = scheduleDuration(schedule);
  const overrun = schedule.voices.filter((_voice, i) => durations[i] - playback > DURATION_EPSILON);
  if (overrun.length > 0) {
    const shortest = schedule.voices.filter((_voice, i) => durations[i] - playback <= DURATION_EPSILON);
    const ends = describeVoices(schedule, shortest);
    const cut = describeVoices(schedule, overrun);
    warnings.push({
      severity: 'warning',
      kind: 'unequal-durations',
      message: `The voices are not the same length. ${ends.text} ${ends.verb('end')} at ${formatSeconds(playback)}, which stops the whole schedule there and cuts ${cut.midSentence} short.`,
    });
  }

  if (schedule.voices.length === 0) {
    warnings.push({
      severity: 'warning',
      kind: 'nothing-to-play',
      message: 'This file contains no voices, so there is nothing to play.',
    });
  } else if (!schedule.voices.some((voice) => isRenderableType(voice.type))) {
    warnings.push({
      severity: 'warning',
      kind: 'nothing-to-play',
      message: 'No voice in this file is of a type Gnaural Web can render, so it would play silence.',
    });
  }

  return warnings;
}

/** The "sensible" carrier range, in Hz. */
export const BASE_RANGE = { min: 20, max: 1500 };

/** Beat frequencies above this are where the binaural-beat effect breaks down, in Hz. */
export const BEAT_CEILING = 40;

/** Below a millionth of full scale a volume is zero, whatever sign the file wrote it with. */
const VOLUME_EPSILON = 1e-6;

/** Where a warning is, addressed the way the document and the editor's selection address a node. */
export type { EntryLocation };

export interface EntryWarning extends ScheduleWarning {
  /**
   * Every node this rule flags, in document order — so the editor can offer to go there. Empty only
   * for `gnaural-regroup` raised against a voice with no entries, which has no node to point at.
   */
  nodes: readonly EntryLocation[];
}

/**
 * Inline validation: values that are legal in the format and wrong for a person, plus the one way a
 * valid document can fail to survive a round trip through Gnaural desktop.
 *
 * Severity is decided against the bundled corpus, not in the abstract — thresholds are kept exactly
 * as written, and the warning/notice split is what lets them stay that way even where real presets
 * disagree (e.g. a cat-purr preset that deliberately gates a 493 Hz tone). A notice says what breaks
 * down is the *percept*, not a defect in the document.
 *
 * One warning per rule, not per node — fifteen gamma-band entries are one sentence with fifteen
 * locations, not fifteen rows. Runs only on the committed document, never inside a drag.
 */
export function entryWarnings(schedule: Schedule): EntryWarning[] {
  const hits = new Map<WarningKind, { nodes: EntryLocation[]; voices: Set<number>; worst: number }>();

  schedule.voices.forEach((voice, voiceIndex) => {
    voice.entries.forEach((entry, entryIndex) => {
      for (const rule of VALUE_RULES) {
        const value = rule.offence(entry, voice.type);
        if (value === null) continue;

        const hit = hits.get(rule.kind);
        if (!hit) {
          hits.set(rule.kind, {
            nodes: [{ voice: voiceIndex, entry: entryIndex }],
            voices: new Set([voiceIndex]),
            worst: value,
          });
          continue;
        }

        hit.nodes.push({ voice: voiceIndex, entry: entryIndex });
        hit.voices.add(voiceIndex);
        if (rule.distance(value) > rule.distance(hit.worst)) hit.worst = value;
      }
    });
  });

  const warnings = VALUE_RULES.flatMap((rule) => {
    const hit = hits.get(rule.kind);
    if (!hit) return [];

    const subject = describeVoices(schedule, [...hit.voices].map((index) => schedule.voices[index]));
    return [
      {
        severity: rule.severity,
        kind: rule.kind,
        message: rule.message(subject, nodeCount(hit.nodes.length), round(hit.worst)),
        nodes: hit.nodes,
      },
    ];
  });

  return [...warnings, ...regroupWarnings(schedule)];
}

interface ValueRule {
  kind: WarningKind;
  severity: WarningSeverity;
  /**
   * The value this rule objects to in one entry, or null when there is nothing to say. The voice's
   * `type` is passed rather than a `tonal` flag because the rules don't all divide at the same
   * place: `beat-exceeds-base` means something only for a binaural voice.
   */
  offence(entry: Entry, type: VoiceType): number | null;
  /** How far outside acceptable a value is. The furthest one is what the message quotes. */
  distance(value: number): number;
  message(subject: VoiceSubject, count: string, worst: number): string;
}

/**
 * The value rules. `beat-exceeds-base` is restricted to type 0 (binaural): the right channel is
 * `basefreq - beatfreq/2`, a channel split only a binaural voice has. `duration === 0` is
 * deliberately absent — a drag's squeeze clamps a node against its neighbour rather than letting it
 * pass, so a zero-length segment can be produced on purpose; only an import can go negative.
 */
const VALUE_RULES: ValueRule[] = [
  {
    kind: 'negative-duration',
    severity: 'warning',
    offence: (entry) => (entry.duration < 0 ? entry.duration : null),
    distance: (value) => -value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('carry')} a negative duration at ${count} (down to ${worst} s). A segment cannot run backwards, so this voice's length and the start of every node after it are wrong.`,
  },
  {
    kind: 'base-too-low',
    severity: 'warning',
    offence: (entry, type) => (isTonalType(type) && entry.baseFreq < BASE_RANGE.min ? entry.baseFreq : null),
    distance: (value) => -value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('drop')} below ${BASE_RANGE.min} Hz at ${count} (down to ${worst} Hz). A carrier that low is beneath hearing, so there is nothing there for a beat to sit on.`,
  },
  {
    kind: 'base-too-high',
    severity: 'notice',
    offence: (entry, type) => (isTonalType(type) && entry.baseFreq > BASE_RANGE.max ? entry.baseFreq : null),
    distance: (value) => value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('reach')} above ${BASE_RANGE.max} Hz at ${count} (up to ${worst} Hz). It plays exactly as written; the beat is faint on a carrier that high.`,
  },
  {
    kind: 'beat-above-band',
    severity: 'notice',
    offence: (entry, type) => (isTonalType(type) && entry.beatFreq > BEAT_CEILING ? entry.beatFreq : null),
    distance: (value) => value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('reach')} a beat above ${BEAT_CEILING} Hz at ${count} (up to ${worst} Hz). It plays exactly as written; a beat is not heard as one this far above the EEG bands.`,
  },
  {
    kind: 'beat-exceeds-base',
    severity: 'warning',
    offence: (entry, type) => {
      // Binaural only: an isochronic voice has no channel split to fail — both ears get
      // `basefreq`, and `beatfreq` is a rate rather than a width.
      const right = entry.baseFreq - entry.beatFreq / 2;
      return type === VoiceType.Binaural && right <= 0 ? right : null;
    },
    distance: (value) => -value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('set')} a beat wider than its own carrier at ${count}. The right channel is base − beat/2 (§3.6), which lands at ${worst} Hz, so the two channels are no longer a pair.`,
  },
  {
    kind: 'volume-out-of-range',
    severity: 'warning',
    offence: (entry) => {
      // Gnaural's own editor writes a silent node as `-2.55352e-19` rather than zero; the rule
      // tolerates what is zero to any listener rather than false-alarming on it.
      const outside = [entry.volumeLeft, entry.volumeRight].filter(
        (value) => value < -VOLUME_EPSILON || value > 1 + VOLUME_EPSILON,
      );
      if (outside.length === 0) return null;
      return outside.reduce((worst, value) => (Math.abs(value - 0.5) > Math.abs(worst - 0.5) ? value : worst));
    },
    distance: (value) => Math.abs(value - 0.5),
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('carry')} a volume outside 0–1 at ${count} (furthest ${worst}). One is the format's full scale: above it the mix clips, and below zero the channel is inverted.`,
  },
];

/**
 * The one way a document that plays correctly here does not survive being reopened in Gnaural
 * desktop. Gnaural does not read `<id>` back at all: it walks the flat list of entries in document
 * order and starts a new voice whenever an entry's `parent` differs from the previous entry's, then
 * takes each voice's description, type and flags by position. So `parent` is an opaque
 * change-detector, not a reference, and three shapes reopen as something other than what was saved.
 * None can arise from a clean document, but dirty imports and a voice reorder can produce them.
 *
 * Detection only — the repair (renumber ids, let the serializer derive `parent`) is `repairVoiceGrouping`.
 */
function regroupWarnings(schedule: Schedule): EntryWarning[] {
  const warnings: EntryWarning[] = [];
  const parentsOf = (voice: Voice) => voice.entries.map((entry) => entryParent(entry, voice.id));

  const empty = schedule.voices.filter((voice) => voice.entries.length === 0);
  if (empty.length > 0) {
    const subject = describeVoices(schedule, empty);
    warnings.push({
      severity: 'warning',
      kind: 'gnaural-regroup',
      message: `${subject.text} ${subject.verb('contain')} no entries. Gnaural builds its voices from the entries alone, so on reopening ${subject.plural ? 'they disappear' : 'it disappears'} and every voice after ${subject.plural ? 'them' : 'it'} takes the wrong name, type and flags.`,
      nodes: [],
    });
  }

  const mixed = schedule.voices.filter((voice) => new Set(parentsOf(voice)).size > 1);
  if (mixed.length > 0) {
    const subject = describeVoices(schedule, mixed);
    warnings.push({
      severity: 'warning',
      kind: 'gnaural-regroup',
      message: `${subject.text} ${subject.verb('contain')} entries belonging to more than one voice. Gnaural starts a new voice wherever that changes, so on reopening ${subject.plural ? 'they split' : 'it splits'} into several and the voices after ${subject.plural ? 'them' : 'it'} take the wrong name, type and flags.`,
      nodes: mixed.map((voice) => ({ voice: schedule.voices.indexOf(voice), entry: 0 })),
    });
  }

  for (let i = 1; i < schedule.voices.length; i += 1) {
    const previous = schedule.voices[i - 1];
    const voice = schedule.voices[i];
    if (previous.entries.length === 0 || voice.entries.length === 0) continue;

    const before = parentsOf(previous);
    if (before[before.length - 1] !== parentsOf(voice)[0]) continue;

    const subject = describeVoices(schedule, [previous, voice]);
    warnings.push({
      severity: 'warning',
      kind: 'gnaural-regroup',
      message: `${subject.text} are next to each other and their entries carry the same owner, so on reopening in Gnaural they merge into one voice. Give one of them a different id.`,
      nodes: [
        { voice: i - 1, entry: previous.entries.length - 1 },
        { voice: i, entry: 0 },
      ],
    });
  }

  return warnings;
}

function nodeCount(count: number): string {
  return `${count} ${count === 1 ? 'node' : 'nodes'}`;
}

/** Enough digits for the presets' 0.001 s entries, without showing a float's full tail. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

interface VoiceSubject {
  /** "Voice tone" or "Voices tone and pulse" — the grammatical subject of a warning sentence. */
  text: string;
  /**
   * The same subject part-way through a sentence: "voice tone", "voices tone and pulse". Only the
   * leading noun is lowercased — a naive `text.toLowerCase()` used to mangle voice *names* too
   * (e.g. a voice literally named "Every rule").
   */
  midSentence: string;
  plural: boolean;
  /** Agrees the verb with the subject: one voice *plays*, two voices *play*. */
  verb(base: string): string;
}

function describeVoices(schedule: Schedule, subset: Voice[]): VoiceSubject {
  const labels = subset.map((voice) => voiceLabel(voice, schedule.voices.indexOf(voice)));
  const plural = labels.length > 1;
  const noun = plural ? 'Voices' : 'Voice';
  const names = list(labels);
  return {
    text: `${noun} ${names}`,
    midSentence: `${noun.toLowerCase()} ${names}`,
    plural,
    verb: (base) => (plural ? base : thirdPerson(base)),
  };
}

/** Third person singular. A bare `+ s` would produce "carrys" and "reachs" for some verbs. */
function thirdPerson(base: string): string {
  if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
