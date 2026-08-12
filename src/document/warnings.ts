import { entryParent } from './serializer';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from './timing';
import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';

/**
 * Everything a file does that the listener should be told about (PLAN.md §3.3, §3.4, §3.7).
 *
 * Two producers, one type. `parseScheduleWithWarnings` reports what was wrong with the *file* —
 * stale declared counts, values that would not parse, reused voice ids — because that information
 * exists only while the XML does and is gone by the time a `Schedule` object stands in its place.
 * `scheduleWarnings` reports what is wrong with the *program* — voice types this app cannot
 * render, voices of unequal length — which is a property of the model and needs no XML.
 *
 * **The severity rule.** A `warning` means what you hear will differ from what the file describes:
 * a silent voice, a schedule cut short. A `notice` means the file was unusual and was handled
 * correctly, recorded so that "did it read my file properly?" has an answer. The distinction is
 * load-bearing, not decorative: of the 19 bundled programs exactly one — `powernap`, with its
 * declared `voicecount=3` against one actual voice — trips anything here at all, and it would be
 * absurd for it to wear a warning for a header §3.4 tells the parser to ignore by design.
 *
 * A third producer, `entryWarnings`, arrived with the editor (§6.1's inline validation). It is the
 * only one whose warnings carry a location, because it is the only one whose reader can go there.
 *
 * Warnings are deliberately **not** stored on `Schedule`. The document is immutable and
 * reference-compared (§4.1), Phase 1's undo/redo depends on that, and anything hanging off it
 * would have to survive the serializer.
 */
export type WarningSeverity = 'warning' | 'notice';

export interface ScheduleWarning {
  severity: WarningSeverity;
  /** Stable discriminator — what tests assert on, and what dedupes repeats across voices. */
  kind: WarningKind;
  message: string;
}

export type WarningKind =
  // Model-derived (§3.3, §3.7)
  | 'pcm-voice'
  | 'unsupported-voice'
  | 'unequal-durations'
  | 'nothing-to-play'
  // File-derived (§3.4)
  | 'stale-count'
  | 'duplicate-voice-id'
  | 'unparseable-value'
  | 'empty-voice'
  // Value-derived, and locatable (§6.1)
  | 'negative-duration'
  | 'base-too-low'
  | 'base-too-high'
  | 'beat-above-band'
  | 'beat-exceeds-base'
  | 'volume-out-of-range'
  | 'gnaural-regroup';

/** Voice types this app renders. Everything else is parsed, preserved, and silent (§3.3). */
const RENDERABLE = new Set<VoiceType>([VoiceType.Binaural, VoiceType.PinkNoise]);

const TYPE_NAMES: Record<number, string> = {
  [VoiceType.Pcm]: 'external audio',
  [VoiceType.IsoPulse]: 'isochronic pulse',
  [VoiceType.IsoPulseAlt]: 'isochronic pulse',
  [VoiceType.WaterDrops]: 'water drops',
  [VoiceType.Rain]: 'rain',
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

  // §3.3 — never silently drop a voice. Type 2 gets its own message: the PCM data lives in an
  // external file whose path the schedule does not record, so it is not "not yet" supported, it
  // is unsupportable from a schedule alone and always will be.
  const pcm = schedule.voices.filter((voice) => voice.type === VoiceType.Pcm);
  if (pcm.length > 0) {
    const subject = describeVoices(schedule, pcm);
    warnings.push({
      severity: 'warning',
      kind: 'pcm-voice',
      message: `${subject.text} ${subject.verb('play')} an external audio file. The Gnaural format does not record where that file is, so this can never be played from the schedule alone — ${subject.plural ? 'they' : 'it'} will be silent.`,
    });
  }

  const unsupported = schedule.voices.filter(
    (voice) => !RENDERABLE.has(voice.type) && voice.type !== VoiceType.Pcm,
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

  // §3.7 — the shortest voice ends the schedule for every voice, so a ragged file loses the tail
  // of everything longer. The chart draws this; this is the same fact in words.
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
      message: `The voices are not the same length. ${ends.text} ${ends.verb('end')} at ${formatSeconds(playback)}, which stops the whole schedule there and cuts ${cut.text.toLowerCase()} short.`,
    });
  }

  if (schedule.voices.length === 0) {
    warnings.push({
      severity: 'warning',
      kind: 'nothing-to-play',
      message: 'This file contains no voices, so there is nothing to play.',
    });
  } else if (!schedule.voices.some((voice) => RENDERABLE.has(voice.type))) {
    warnings.push({
      severity: 'warning',
      kind: 'nothing-to-play',
      message: 'No voice in this file is of a type Gnaural Web can render, so it would play silence.',
    });
  }

  return warnings;
}

/** §6.1's "sensible" carrier range, in Hz. */
export const BASE_RANGE = { min: 20, max: 1500 };

/** §6.1's "beat frequencies above ~40 Hz where the effect breaks down", in Hz. */
export const BEAT_CEILING = 40;

/**
 * Voice types whose `basefreq` and `beatfreq` describe a tone, and are therefore the only ones the
 * frequency rules below mean anything for.
 *
 * Noise (type 1) ignores both — all nine noise voices in the bundled corpus carry base 100 and beat
 * 0, which a rule applied to every type would either flag or would have to make an exception for —
 * and §3.3 records that water drops (type 5) reads the *first* `beatfreq` as a drop count rather
 * than a frequency. Volume and duration are read by every type, so those rules are not restricted.
 */
const TONAL = new Set<VoiceType>([VoiceType.Binaural, VoiceType.IsoPulse, VoiceType.IsoPulseAlt]);

/** Where a warning is, addressed the way the document and the editor's selection address a node. */
export interface EntryLocation {
  voice: number;
  entry: number;
}

export interface EntryWarning extends ScheduleWarning {
  /**
   * Every node this rule flags, in document order — so the editor can offer to go there.
   *
   * Empty only for `gnaural-regroup` raised against a voice with no entries, which by definition
   * has no node to point at.
   */
  nodes: readonly EntryLocation[];
}

/**
 * §6.1's inline validation: values that are legal in the format and wrong for a person (PLAN.md
 * §6.1), plus the one way a valid document can fail to survive a round trip through Gnaural desktop.
 *
 * **Severity is decided against the corpus, not in the abstract.** Measured through the parser over
 * all 19 bundled programs (354 entries): base 100–1046 Hz, volume 0–1, no duration below 0.001 s —
 * so those rules trip nothing at all — but **beat rises to 70 Hz in four shipped presets, at 15
 * entries**. §6.1's 40 Hz threshold is kept exactly as written and carried as a `notice`: a 70 Hz
 * beat is played precisely as authored, and what breaks down is the *percept*, which is a fact about
 * hearing rather than a defect in the document. Raising the threshold until the library came out
 * clean would have thrown away §6.1's advice silently; the severity split exists for this.
 *
 * **One warning per rule, not per node.** Fifteen gamma-band entries are one sentence with fifteen
 * locations, not fifteen rows.
 *
 * Cheap enough to be uninteresting: measured at 0.001 ms over the densest corpus document (77
 * entries) and 0.011 ms over a synthetic one where every node trips every rule. It still runs only
 * on the committed document — never inside a drag, where step 5's re-render budget lives.
 */
export function entryWarnings(schedule: Schedule): EntryWarning[] {
  const hits = new Map<WarningKind, { nodes: EntryLocation[]; voices: Set<number>; worst: number }>();

  schedule.voices.forEach((voice, voiceIndex) => {
    const tonal = TONAL.has(voice.type);

    voice.entries.forEach((entry, entryIndex) => {
      for (const rule of VALUE_RULES) {
        const value = rule.offence(entry, tonal);
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
  /** The value this rule objects to in one entry, or null when there is nothing to say. */
  offence(entry: Entry, tonal: boolean): number | null;
  /** How far outside acceptable a value is. The furthest one is what the message quotes. */
  distance(value: number): number;
  message(subject: VoiceSubject, count: string, worst: number): string;
}

/**
 * §6.1's list, in its order, plus one it does not name.
 *
 * The addition is `beat-exceeds-base`: §3.6 puts the right channel at `basefreq - beatfreq/2`, so a
 * beat wider than its carrier drives that channel to zero and below. Nothing in the corpus comes
 * near it (110 Hz against a 70 Hz beat is the closest, at 75 Hz) and no drag can produce it, but the
 * numeric panel can, and it is the one combination here that is not a matter of taste.
 *
 * **`duration === 0` is deliberately absent.** Step 5's squeeze clamps a node against its neighbour
 * rather than letting it pass, so a zero-length segment is something a person can produce on purpose
 * with a drag; §6.1 says *negative*, which is the case only an import can reach — the parser has no
 * clamp, so `duration="-5"` arrives in the document intact.
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
    offence: (entry, tonal) => (tonal && entry.baseFreq < BASE_RANGE.min ? entry.baseFreq : null),
    distance: (value) => -value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('drop')} below ${BASE_RANGE.min} Hz at ${count} (down to ${worst} Hz). A carrier that low is beneath hearing, so there is nothing there for a beat to sit on.`,
  },
  {
    kind: 'base-too-high',
    severity: 'notice',
    offence: (entry, tonal) => (tonal && entry.baseFreq > BASE_RANGE.max ? entry.baseFreq : null),
    distance: (value) => value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('reach')} above ${BASE_RANGE.max} Hz at ${count} (up to ${worst} Hz). It plays exactly as written; the beat is faint on a carrier that high.`,
  },
  {
    kind: 'beat-above-band',
    severity: 'notice',
    offence: (entry, tonal) => (tonal && entry.beatFreq > BEAT_CEILING ? entry.beatFreq : null),
    distance: (value) => value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('reach')} a beat above ${BEAT_CEILING} Hz at ${count} (up to ${worst} Hz). It plays exactly as written; a beat is not heard as one this far above the EEG bands.`,
  },
  {
    kind: 'beat-exceeds-base',
    severity: 'warning',
    offence: (entry, tonal) => {
      const right = entry.baseFreq - entry.beatFreq / 2;
      return tonal && right <= 0 ? right : null;
    },
    distance: (value) => -value,
    message: (subject, count, worst) =>
      `${subject.text} ${subject.verb('set')} a beat wider than its own carrier at ${count}. The right channel is base − beat/2 (§3.6), which lands at ${worst} Hz, so the two channels are no longer a pair.`,
  },
  {
    kind: 'volume-out-of-range',
    severity: 'warning',
    offence: (entry) => {
      const outside = [entry.volumeLeft, entry.volumeRight].filter((value) => value < 0 || value > 1);
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
 * desktop (§6.3 makes that a definition-of-done item).
 *
 * **Gnaural does not read `<id>` back at all.** `gxml_XMLParser` has no branch for it;
 * `SG_RestoreBackupData` (ScheduleGUI.c:2213) walks the flat list of entries in document order and
 * starts a new voice **whenever an entry's `parent` differs from the previous entry's**, then takes
 * each voice's description, type and flags from the `<voice>` elements by position. So `parent` is an
 * opaque change-detector, not a reference, and three shapes reopen as something other than what was
 * saved. None can arise from a clean document — all 51 voices in the bundled corpus carry
 * `parent == id` with no voice mixing two values — but §3.4's dirty imports can, and step 6's
 * reorder can move two of them next to each other.
 *
 * Detection only. The repair — renumber the ids and let the serializer derive `parent` — is a
 * command, and commands are step 9, alongside §3.7's "pad to longest".
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
  plural: boolean;
  /** Agrees the verb with the subject: one voice *plays*, two voices *play*. */
  verb(base: string): string;
}

function describeVoices(schedule: Schedule, subset: Voice[]): VoiceSubject {
  const labels = subset.map((voice) => voiceLabel(voice, schedule.voices.indexOf(voice)));
  const plural = labels.length > 1;
  return {
    text: `${plural ? 'Voices' : 'Voice'} ${list(labels)}`,
    plural,
    verb: (base) => (plural ? base : thirdPerson(base)),
  };
}

/**
 * Third person singular.
 *
 * A bare `+ s` was enough while the messages said "plays" and "uses", and it silently produces
 * "carrys" and "reachs" for the verbs §6.1's validation wanted. Fixing the helper rather than
 * choosing verbs around it: the point of `describeVoices` is that a message cannot disagree with its
 * own subject, and it should go on being true of whatever the next message says.
 */
function thirdPerson(base: string): string {
  if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
