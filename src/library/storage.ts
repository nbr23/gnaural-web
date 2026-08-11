import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { scheduleDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import type { NoiseColour } from '../engine/noise';

/**
 * Local-first persistence (PLAN.md §5.1): imported programs, drafts and settings, in IndexedDB.
 *
 * Separate stores rather than one because they have nothing in common but their durability —
 * `programs` is a growing keyed collection the library lists, `drafts` is the editor's autosave
 * (§6.1), and `settings` is a handful of scalars read once at startup.
 *
 * Everything here is storage only: nothing parses, nothing renders, and an import is handed
 * already-parsed metadata by the caller so a malformed file fails where it can be reported.
 */

const DB_NAME = 'gnaural-web';
const DB_VERSION = 2;

export interface ImportedProgram {
  id: string;
  /**
   * The file's **original text**, not re-serialized XML. Round-trip is a fixed point, so the two
   * would play identically — but re-exporting a file the user imported should hand back their own
   * bytes, not ours.
   */
  text: string;
  /** Filename it arrived as, or the share link it came from. Shown as the byline. */
  sourceName: string;
  title: string;
  author: string;
  description: string;
  /** The shortest voice, per §3.7 — how long it actually plays, not its declared `totaltime`. */
  durationSeconds: number;
  importedAt: number;
}

/** Everything the app remembers between visits. Read once at startup; see `useSettings`. */
export interface Settings {
  masterGain: number;
  exportSampleRate: number;
  wakeLock: boolean;
  /** Whether the one-time headphone notice (§4.4) has been dismissed. */
  headphoneNoticeSeen: boolean;
  /**
   * The app-level noise layer (§4.5b) — a listening preference that belongs to the person, not to
   * any program, which is why it lives here rather than with an imported schedule.
   */
  noiseColour: NoiseColour;
  noiseGain: number;
  /**
   * Where Live mode's sliders were left (§6.1). The same class of thing as the noise layer: a
   * preference about listening, belonging to the person rather than to any program.
   *
   * Not the hash — `#/s/` already means "a program in a URL", a live session is not a program, and
   * writing the fragment on every slider move would either flood the history or fight the back
   * button the router exists for.
   */
  liveBaseFreq: number;
  liveBeatFreq: number;
}

/**
 * A program being authored (§6.1). Its content is **serialized XML**, not a JSON blob of the model:
 * the round-trip is a proven fixed point, so a recovered draft is exportable and openable in
 * Gnaural desktop by definition, and the editor has no second representation to keep in step.
 *
 * The display fields are derived once per save, like an imported program's, so listing the library
 * parses nothing.
 */
export interface Draft {
  id: string;
  xml: string;
  title: string;
  /** What it was forked from, shown as the byline — a draft rarely has an author of its own. */
  sourceName: string;
  /** The shortest voice, per §3.7 — how long it would actually play. */
  durationSeconds: number;
  createdAt: number;
  updatedAt: number;
}

interface GnauralDB extends DBSchema {
  programs: { key: string; value: ImportedProgram };
  drafts: { key: string; value: Draft };
  settings: { key: keyof Settings; value: Settings[keyof Settings] };
}

let connection: Promise<IDBPDatabase<GnauralDB>> | null = null;

function db(): Promise<IDBPDatabase<GnauralDB>> {
  // Each version adds only what it introduced. An unconditional `createObjectStore` would throw
  // `ConstraintError` against any database already at version 1 — which is every existing install,
  // and it would take the whole library down with it.
  connection ??= openDB<GnauralDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('programs', { keyPath: 'id' });
        database.createObjectStore('settings');
      }
      if (oldVersion < 2) {
        database.createObjectStore('drafts', { keyPath: 'id' });
      }
    },
  });
  return connection;
}

/** Drops the cached connection so a fresh database is opened next time. Tests only. */
export function resetConnection(): void {
  connection = null;
}

/** Most recently imported first — the one you just added is the one you want to see. */
export async function listImported(): Promise<ImportedProgram[]> {
  const all = await (await db()).getAll('programs');
  return all.sort((a, b) => b.importedAt - a.importedAt);
}

export async function getImported(id: string): Promise<ImportedProgram | undefined> {
  return (await db()).get('programs', id);
}

/**
 * Store a schedule the user brought in, returning the entry the library should route to.
 *
 * Importing the same text twice returns the existing entry instead of a duplicate: the app has no
 * session storage for opened files any more, so re-dropping the same file after a reload is the
 * ordinary case rather than a mistake.
 */
export async function importProgram(
  sourceName: string,
  text: string,
  schedule: Schedule,
): Promise<ImportedProgram> {
  const database = await db();

  const existing = (await database.getAll('programs')).find((program) => program.text === text);
  if (existing) return existing;

  const program: ImportedProgram = {
    id: crypto.randomUUID(),
    text,
    sourceName,
    title: schedule.title.trim() || sourceName,
    author: schedule.author.trim(),
    description: schedule.description.trim(),
    durationSeconds: scheduleDuration(schedule),
    importedAt: Date.now(),
  };

  await database.put('programs', program);
  return program;
}

export async function removeImported(id: string): Promise<void> {
  await (await db()).delete('programs', id);
}

/** Most recently *edited* first — a draft is a thing you come back to, not a thing you filed. */
export async function listDrafts(): Promise<Draft[]> {
  const all = await (await db()).getAll('drafts');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(id: string): Promise<Draft | undefined> {
  return (await db()).get('drafts', id);
}

/**
 * Fork a document into a new draft. Nothing is deduped, unlike an import: two copies of the same
 * program is the ordinary way to try two ideas.
 */
export async function createDraft(
  sourceName: string,
  xml: string,
  schedule: Schedule,
): Promise<Draft> {
  const now = Date.now();
  const draft: Draft = {
    id: crypto.randomUUID(),
    xml,
    title: schedule.title.trim() || sourceName,
    sourceName,
    durationSeconds: scheduleDuration(schedule),
    createdAt: now,
    updatedAt: now,
  };

  await (await db()).put('drafts', draft);
  return draft;
}

/**
 * Autosave. A draft removed from the library while its editor is open is left removed rather than
 * resurrected by the next keystroke.
 */
export async function saveDraft(id: string, xml: string, schedule: Schedule): Promise<void> {
  const database = await db();
  const existing = await database.get('drafts', id);
  if (!existing) return;

  await database.put('drafts', {
    ...existing,
    xml,
    title: schedule.title.trim() || existing.sourceName,
    durationSeconds: scheduleDuration(schedule),
    updatedAt: Date.now(),
  });
}

export async function removeDraft(id: string): Promise<void> {
  await (await db()).delete('drafts', id);
}

export async function loadSettings(): Promise<Partial<Settings>> {
  const database = await db();
  const store = database.transaction('settings').store;
  const settings: Partial<Settings> = {};

  for await (const cursor of store) {
    Object.assign(settings, { [cursor.key]: cursor.value });
  }

  return settings;
}

export async function saveSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await (await db()).put('settings', value, key);
}
