import { DURATION_EPSILON, scheduleDuration, voiceDuration } from './timing';
import type { Schedule, Voice } from './types';
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
  | 'empty-voice';

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
    verb: (base) => (plural ? base : `${base}s`),
  };
}

function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
