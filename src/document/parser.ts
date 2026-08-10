import type { Entry, Schedule, Voice } from './types';
import { VoiceType } from './types';

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

function childrenOf(parent: Element): Element[] {
  return Array.from(parent.children);
}

function childText(parent: Element, tag: string): string | undefined {
  const child = childrenOf(parent).find((c) => c.tagName === tag);
  return child ? (child.textContent ?? '') : undefined;
}

function parseNum(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

function attrNum(el: Element, name: string, fallback: number): number {
  return parseNum(el.getAttribute(name) ?? undefined, fallback);
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

  const preserved: Record<string, string> = {};
  for (const child of childrenOf(root)) {
    if (DEDICATED_SCHEDULE_ELEMENTS.has(child.tagName)) continue;
    preserved[child.tagName] = child.textContent ?? '';
  }

  const voices = childrenOf(root)
    .filter((c) => c.tagName === 'voice')
    .map(parseVoice);

  return {
    title: childText(root, 'title') ?? '',
    description: childText(root, 'schedule_description') ?? '',
    author: childText(root, 'author') ?? '',
    loops: parseNum(childText(root, 'loops'), 1),
    masterVolume: {
      left: parseNum(childText(root, 'overallvolume_left'), 1),
      right: parseNum(childText(root, 'overallvolume_right'), 1),
    },
    stereoSwap: parseBool01(childText(root, 'stereoswap'), false),
    voices,
    preserved,
  };
}

function parseVoice(voiceEl: Element): Voice {
  const preserved: Record<string, string> = {};
  for (const child of childrenOf(voiceEl)) {
    if (DEDICATED_VOICE_ELEMENTS.has(child.tagName)) continue;
    preserved[child.tagName] = child.textContent ?? '';
  }

  const entriesContainer = childrenOf(voiceEl).find((c) => c.tagName === 'entries');
  const entries = entriesContainer
    ? childrenOf(entriesContainer)
        .filter((c) => c.tagName === 'entry')
        .map(parseEntry)
    : [];

  return {
    id: parseNum(childText(voiceEl, 'id'), 0),
    description: childText(voiceEl, 'description') ?? '',
    type: parseNum(childText(voiceEl, 'type'), 0) as VoiceType,
    muted: parseBool01(childText(voiceEl, 'voice_mute'), false),
    hidden: parseBool01(childText(voiceEl, 'voice_hide'), false),
    mono: parseBool01(childText(voiceEl, 'voice_mono'), false),
    entries,
    preserved,
  };
}

function parseEntry(entryEl: Element): Entry {
  const preserved: Record<string, string> = {};
  for (const attr of Array.from(entryEl.attributes)) {
    if (DEDICATED_ENTRY_ATTRIBUTES.has(attr.name)) continue;
    preserved[attr.name] = attr.value;
  }

  return {
    duration: attrNum(entryEl, 'duration', 0),
    volumeLeft: attrNum(entryEl, 'volume_left', 1),
    volumeRight: attrNum(entryEl, 'volume_right', 1),
    beatFreq: attrNum(entryEl, 'beatfreq', 0),
    baseFreq: attrNum(entryEl, 'basefreq', 0),
    preserved,
  };
}
