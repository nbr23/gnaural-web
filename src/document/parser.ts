import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';
import type { ScheduleWarning } from './warnings';

/**
 * Schedule-level child elements that are never captured verbatim into `preserved`: either a
 * dedicated `Schedule` field, the structural `voice` list, or a declared count/duration
 * (`totaltime`, `voicecount`, `totalentrycount`) that PLAN.md §3.4 says to derive from the DOM
 * and rewrite correctly on export rather than round-trip verbatim.
 */
const DEDICATED_SCHEDULE_ELEMENTS = new Set([
  'title',
  'schedule_description',
  'author',
  'loops',
  'overallvolume_left',
  'overallvolume_right',
  'stereoswap',
  'voice',
  'totaltime',
  'voicecount',
  'totalentrycount',
]);

/** Voice-level child elements with a dedicated `Voice` field, handled structurally, or derived. */
const DEDICATED_VOICE_ELEMENTS = new Set([
  'description',
  'id',
  'type',
  'voice_hide',
  'voice_mute',
  'voice_mono',
  'entries',
  'entrycount',
]);

/** Entry-level attributes with a dedicated `Entry` field. */
const DEDICATED_ENTRY_ATTRIBUTES = new Set([
  'duration',
  'volume_left',
  'volume_right',
  'beatfreq',
  'basefreq',
]);

/**
 * Collects what §3.4's defensive handling silently absorbed, so the app can say what it did.
 *
 * Nothing here changes how a file is parsed — every fallback below was already the behaviour. The
 * only new thing is that it leaves a record instead of being invisible.
 */
class ParseReport {
  readonly warnings: ScheduleWarning[] = [];
  /** Field names whose value would not parse, aggregated so ten bad entries make one sentence. */
  private readonly unparseable = new Set<string>();

  add(severity: ScheduleWarning['severity'], kind: ScheduleWarning['kind'], message: string): void {
    this.warnings.push({ severity, kind, message });
  }

  unparseableValue(field: string): void {
    this.unparseable.add(field);
  }

  finish(): ScheduleWarning[] {
    if (this.unparseable.size > 0) {
      const fields = [...this.unparseable].sort();
      this.warnings.push({
        severity: 'warning',
        kind: 'unparseable-value',
        // A warning, not a notice: a value that fell back to a default is a value the file asked
        // for and did not get, which is audible.
        message: `Some values could not be read and fell back to defaults: ${fields.join(', ')}.`,
      });
    }
    return this.warnings;
  }
}

function childrenOf(parent: Element): Element[] {
  return Array.from(parent.children);
}

function childText(parent: Element, tag: string): string | undefined {
  const child = childrenOf(parent).find((c) => c.tagName === tag);
  return child ? (child.textContent ?? '') : undefined;
}

function parseNum(text: string | undefined, fallback: number, report?: ParseReport, field?: string): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (Number.isFinite(n)) return n;
  if (report && field) report.unparseableValue(field);
  return fallback;
}

function attrNum(el: Element, name: string, fallback: number, report?: ParseReport): number {
  return parseNum(el.getAttribute(name) ?? undefined, fallback, report, name);
}

function parseBool01(text: string | undefined, fallback: boolean): boolean {
  if (text === undefined) return fallback;
  return text.trim() === '1';
}

/**
 * Parse a `.gnaural` XML document into a `Schedule`.
 *
 * Never trusts declared counts (`voicecount`, `totalentrycount`, `totaltime`) — every count is
 * derived from the actual DOM (PLAN.md §3.4). Never drops an entry or voice for having a
 * degenerate value (zero frequency, zero volume). Unrecognised elements/attributes are captured
 * in each level's `preserved` map so serialization can round-trip them losslessly.
 */
export function parseSchedule(xml: string): Schedule {
  return parseScheduleWithWarnings(xml).schedule;
}

export interface ParseResult {
  schedule: Schedule;
  /** What §3.4's defensive handling absorbed. Empty for a clean file, which is most of them. */
  warnings: ScheduleWarning[];
}

/**
 * `parseSchedule`, plus a record of everything unusual the file contained (§3.4's "user-visible
 * warning list for anything unusual").
 *
 * Kept as a separate entry point rather than changing `parseSchedule`'s return type: most callers
 * — round-trip tests, the serializer's fixtures, the share-link decoder — want the document and
 * nothing else, and the information collected here has no meaning once the XML is gone.
 */
export function parseScheduleWithWarnings(xml: string): ParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;

  // A parse failure is reported as a `parsererror` element, which is not always the root: some
  // implementations wrap it in a document of their own. Look for it anywhere.
  if (!root || doc.querySelector('parsererror')) {
    throw new Error('Malformed XML — this file is not a Gnaural schedule.');
  }

  // Well-formed XML that simply isn't a schedule (an SVG, an RSS feed) would otherwise parse
  // "successfully" into a schedule with no voices, and the app would present an empty program
  // rather than saying the file was wrong.
  if (root.tagName !== 'schedule') {
    throw new Error(`Not a Gnaural schedule — the root element is <${root.tagName}>.`);
  }

  const report = new ParseReport();

  const preserved: Record<string, string> = {};
  for (const child of childrenOf(root)) {
    if (DEDICATED_SCHEDULE_ELEMENTS.has(child.tagName)) continue;
    preserved[child.tagName] = child.textContent ?? '';
  }

  const voiceElements = childrenOf(root).filter((c) => c.tagName === 'voice');
  const voices = voiceElements.map((el, index) => parseVoice(el, index, report));

  checkDeclaredCount(report, childText(root, 'voicecount'), voices.length, 'voices');
  checkDeclaredCount(
    report,
    childText(root, 'totalentrycount'),
    voices.reduce((total, voice) => total + voice.entries.length, 0),
    'entries',
  );

  const ids = voices.map((voice) => voice.id);
  if (new Set(ids).size !== ids.length) {
    report.add(
      'notice',
      'duplicate-voice-id',
      'Two or more voices share an id. Voices are tracked by position instead, so this changes nothing about playback.',
    );
  }

  const schedule: Schedule = {
    title: childText(root, 'title') ?? '',
    description: childText(root, 'schedule_description') ?? '',
    author: childText(root, 'author') ?? '',
    loops: parseNum(childText(root, 'loops'), 1, report, 'loops'),
    masterVolume: {
      left: parseNum(childText(root, 'overallvolume_left'), 1, report, 'overallvolume_left'),
      right: parseNum(childText(root, 'overallvolume_right'), 1, report, 'overallvolume_right'),
    },
    stereoSwap: parseBool01(childText(root, 'stereoswap'), false),
    voices,
    preserved,
  };

  return { schedule, warnings: report.finish() };
}

/**
 * §3.4's headline case: `powernap.gnaural` declares three voices and fourteen entries against one
 * voice and twelve entries. A notice rather than a warning — the declared counts are ignored by
 * design and rewritten correctly on export, so nothing about playback is affected.
 */
function checkDeclaredCount(
  report: ParseReport,
  declaredText: string | undefined,
  actual: number,
  noun: string,
): void {
  if (declaredText === undefined) return;
  const declared = Number(declaredText);
  if (!Number.isFinite(declared) || declared === actual) return;

  report.add(
    'notice',
    'stale-count',
    `The file says it has ${declared} ${noun} but contains ${actual}. The real contents were used.`,
  );
}

function parseVoice(voiceEl: Element, index: number, report: ParseReport): Voice {
  const preserved: Record<string, string> = {};
  for (const child of childrenOf(voiceEl)) {
    if (DEDICATED_VOICE_ELEMENTS.has(child.tagName)) continue;
    preserved[child.tagName] = child.textContent ?? '';
  }

  const entriesContainer = childrenOf(voiceEl).find((c) => c.tagName === 'entries');
  const entries = entriesContainer
    ? childrenOf(entriesContainer)
        .filter((c) => c.tagName === 'entry')
        .map((el) => parseEntry(el, report))
    : [];

  const description = childText(voiceEl, 'description') ?? '';

  if (entries.length === 0) {
    report.add(
      'notice',
      'empty-voice',
      `${description.trim() || `Voice ${index + 1}`} has no entries, so it has no duration and makes no sound.`,
    );
  }

  return {
    id: parseNum(childText(voiceEl, 'id'), 0, report, 'id'),
    description,
    type: parseNum(childText(voiceEl, 'type'), 0, report, 'type') as VoiceType,
    muted: parseBool01(childText(voiceEl, 'voice_mute'), false),
    hidden: parseBool01(childText(voiceEl, 'voice_hide'), false),
    mono: parseBool01(childText(voiceEl, 'voice_mono'), false),
    entries,
    preserved,
  };
}

function parseEntry(entryEl: Element, report: ParseReport): Entry {
  const preserved: Record<string, string> = {};
  for (const attr of Array.from(entryEl.attributes)) {
    if (DEDICATED_ENTRY_ATTRIBUTES.has(attr.name)) continue;
    preserved[attr.name] = attr.value;
  }

  return {
    duration: attrNum(entryEl, 'duration', 0, report),
    volumeLeft: attrNum(entryEl, 'volume_left', 1, report),
    volumeRight: attrNum(entryEl, 'volume_right', 1, report),
    beatFreq: attrNum(entryEl, 'beatfreq', 0, report),
    baseFreq: attrNum(entryEl, 'basefreq', 0, report),
    preserved,
  };
}
