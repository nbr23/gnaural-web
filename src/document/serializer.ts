import type { Entry, Schedule, Voice } from './types';

/**
 * Schedule-level `preserved` keys with a canonical position in the element order (PLAN.md
 * §3.1). Every other `preserved` key is unrecognised/future data and gets appended after them.
 */
const CANONICAL_SCHEDULE_PRESERVED_KEYS = ['gnauralfile_version', 'gnaural_version', 'date', 'graphview'];

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

/** Shortest round-trippable representation — avoids `toFixed`-style precision artifacts. */
function formatNum(n: number): string {
  return String(n);
}

function elementLine(tag: string, text: string): string {
  return `<${tag}>${escapeXmlText(text)}</${tag}>`;
}

function voiceDuration(voice: Voice): number {
  return voice.entries.reduce((sum, e) => sum + e.duration, 0);
}

/**
 * Serialize a `Schedule` back to `.gnaural` XML.
 *
 * `totaltime`, `voicecount`, and `totalentrycount` are always recomputed from the actual voices
 * and entries (PLAN.md §3.4) — never taken from `preserved`, even if the source file declared
 * different values. Every other unrecognised element/attribute captured in `preserved` at parse
 * time is re-emitted verbatim.
 */
export function serializeSchedule(schedule: Schedule): string {
  const parts: string[] = [];

  for (const key of CANONICAL_SCHEDULE_PRESERVED_KEYS) {
    if (key in schedule.preserved) parts.push(elementLine(key, schedule.preserved[key]));
  }

  const totalTime = schedule.voices.reduce((max, v) => Math.max(max, voiceDuration(v)), 0);
  const totalEntryCount = schedule.voices.reduce((n, v) => n + v.entries.length, 0);

  parts.push(elementLine('title', schedule.title));
  parts.push(elementLine('schedule_description', schedule.description));
  parts.push(elementLine('author', schedule.author));
  parts.push(elementLine('totaltime', formatNum(totalTime)));
  parts.push(elementLine('voicecount', String(schedule.voices.length)));
  parts.push(elementLine('totalentrycount', String(totalEntryCount)));
  parts.push(elementLine('loops', formatNum(schedule.loops)));
  parts.push(elementLine('overallvolume_left', formatNum(schedule.masterVolume.left)));
  parts.push(elementLine('overallvolume_right', formatNum(schedule.masterVolume.right)));
  parts.push(elementLine('stereoswap', schedule.stereoSwap ? '1' : '0'));

  for (const [key, value] of Object.entries(schedule.preserved)) {
    if (CANONICAL_SCHEDULE_PRESERVED_KEYS.includes(key)) continue;
    parts.push(elementLine(key, value));
  }

  for (const voice of schedule.voices) {
    parts.push(serializeVoice(voice));
  }

  return `<?xml version="1.0"?>\n<!-- See http://gnaural.sourceforge.net -->\n<schedule>${parts.join('')}</schedule>`;
}

function serializeVoice(voice: Voice): string {
  const parts: string[] = [];

  parts.push(elementLine('description', voice.description));
  parts.push(elementLine('id', String(voice.id)));
  parts.push(elementLine('type', String(voice.type)));
  if ('voice_state' in voice.preserved) parts.push(elementLine('voice_state', voice.preserved.voice_state));
  parts.push(elementLine('voice_hide', voice.hidden ? '1' : '0'));
  parts.push(elementLine('voice_mute', voice.muted ? '1' : '0'));
  parts.push(elementLine('voice_mono', voice.mono ? '1' : '0'));
  parts.push(elementLine('entrycount', String(voice.entries.length)));

  for (const [key, value] of Object.entries(voice.preserved)) {
    if (key === 'voice_state') continue;
    parts.push(elementLine(key, value));
  }

  const entriesXml = voice.entries.map((entry) => serializeEntry(entry, voice.id)).join('');
  parts.push(`<entries>${entriesXml}</entries>`);

  return `<voice>${parts.join('')}</voice>`;
}

/**
 * The `parent` attribute an entry will be written with.
 *
 * Real files always carry one, so in practice it round-trips from `preserved`; the owning voice's
 * id is the fallback for an entry this app created. Exported because it is not merely a detail of
 * serialization: Gnaural rebuilds its voices from this value and nothing else (`SG_RestoreBackupData`,
 * ScheduleGUI.c:2213), so `warnings.ts` has to read exactly what will be written.
 */
export function entryParent(entry: Entry, voiceId: number): string {
  return entry.preserved.parent ?? String(voiceId);
}

function serializeEntry(entry: Entry, voiceId: number): string {
  const attrs: [string, string][] = [
    ['parent', entryParent(entry, voiceId)],
    ['duration', formatNum(entry.duration)],
    ['volume_left', formatNum(entry.volumeLeft)],
    ['volume_right', formatNum(entry.volumeRight)],
    ['beatfreq', formatNum(entry.beatFreq)],
    ['basefreq', formatNum(entry.baseFreq)],
  ];
  if ('state' in entry.preserved) attrs.push(['state', entry.preserved.state]);

  for (const [key, value] of Object.entries(entry.preserved)) {
    if (key === 'parent' || key === 'state') continue;
    attrs.push([key, value]);
  }

  const attrStr = attrs.map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`).join(' ');
  return `<entry ${attrStr}/>`;
}
