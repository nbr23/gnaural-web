import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { scheduleDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import type { NoiseColour } from '../engine/noise';

/**
 * Local-first persistence (PLAN.md §5.1): imported programs and settings, in IndexedDB.
 *
 * Two stores rather than one because they have nothing in common but their durability —
 * `programs` is a growing keyed collection the library lists, `settings` is a handful of scalars
 * read once at startup.
 *
 * Everything here is storage only: nothing parses, nothing renders, and an import is handed
 * already-parsed metadata by the caller so a malformed file fails where it can be reported.
 */

const DB_NAME = 'gnaural-web';
const DB_VERSION = 1;

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
}

interface GnauralDB extends DBSchema {
  programs: { key: string; value: ImportedProgram };
  settings: { key: keyof Settings; value: Settings[keyof Settings] };
}

let connection: Promise<IDBPDatabase<GnauralDB>> | null = null;

function db(): Promise<IDBPDatabase<GnauralDB>> {
  connection ??= openDB<GnauralDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('programs', { keyPath: 'id' });
      database.createObjectStore('settings');
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
