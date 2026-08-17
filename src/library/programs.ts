import gnauralManifest from '../../fixtures/gnaural/manifest.json';
import manifest from '../../fixtures/presets/manifest.json';
import type { ParseResult } from '../document/parser';
import { parseScheduleWithWarnings } from '../document/parser';
import { seriesColor } from '../viz/palette';

/**
 * The bundled program library, from two separate collections that must not be confused for each
 * other (`fixtures/gnaural/README.md`):
 *
 * - **Gnaural's own**, the 21 `Mindstates` presets published at
 *   `sourceforge.net/projects/gnaural/files/Presets/` between 2009 and 2020 and shipped here
 *   unmodified — split into the seven Bret Logan signed himself and the fourteen contributed to the
 *   project by other people.
 * - **The Android app's**, 17 presets converted from `DefaultProgramsBuilder.java` plus the two
 *   Gnaural files it redistributed in edited form.
 *
 * 40 programs. Each collection's manifest carries the metadata `.gnaural` has no field for —
 * category, attribution and provenance — while the `.gnaural` files themselves remain the source of
 * truth for playback. Programs the user imported are separate, in `storage.ts`: they have no
 * category and their metadata is derived from the file rather than curated.
 */
/** Which of the two bundled collections a program belongs to — its credit, and its section. */
export type Collection = 'gnaural' | 'android';

export interface BundledProgram {
  /** Stable id, also the filename stem and the `#/p/<id>` route segment. */
  id: string;
  title: string;
  category: string;
  author: string;
  description: string;
  collection: Collection;
  /** From the manifest, for display in the list before the file is fetched and parsed. */
  durationSeconds: number;
  /**
   * `<loops>` (§3.2): 1 plays once, anything else repeats — which is a property of the program the
   * list has to show, since a 0.8 s schedule that repeats is not a 0.8 s programme. How many passes
   * actually play is the engine's answer, not the manifest's (`passCount`).
   */
  loops: number;
  /**
   * Whether this program had a sampled ambient bed on Android that did not survive conversion —
   * the manifest's `UNITY` background, four presets in all
   * (`fixtures/presets/README.md`).
   *
   * Carried only so the player can point at the app-level noise layer (§4.5b), which that README
   * names as their remedy. Nothing is enabled on the listener's behalf: §4.6 keeps the app purely
   * synthetic and §3.8 item 6 is what forcing noise on looks like when it goes wrong.
   */
  lostAmbientBed: boolean;
  /**
   * Whether this program was **converted** from the Android app's `DefaultProgramsBuilder.java`
   * rather than shipped by it as a `.gnaural` file already.
   *
   * The 17 presets were; `powernap` and `airplanetravelaid` were not. The library says so, because
   * the conversion caveats in `fixtures/presets/README.md` — the dropped ambient beds, the
   * per-period fades that were a property of the Android engine rather than of the data — apply to
   * one set and not the other.
   */
  converted: boolean;
}

/** The manifest's name for the ambient ogg loop PLAN.md §4.6 deliberately left behind. */
const AMBIENT_BACKGROUND = 'UNITY';

/**
 * Lazy so each program is its own chunk rather than ~96 KB in the main bundle — the list only
 * needs the manifest, and the service worker can then precache the schedules individually.
 */
const sources = import.meta.glob('../../fixtures/**/*.gnaural', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

function idFromPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.gnaural$/, '');
}

/**
 * The two Gnaural files the Android app redistributed rather than generated, **as it shipped
 * them** — which is not as Gnaural published them. Both upstream originals are in
 * `fixtures/gnaural/` and both were edited on the way through: `powernap` lost the water-drops and
 * rain voices its 3-voice header still claims, and the travel aid's author became `@Gnaural` and
 * its description was rewritten (`fixtures/gnaural/README.md`).
 *
 * Kept beside the originals rather than replaced by them: these are the files this app has been
 * playing, and a favourite or a fork pointing at `#/p/powernap` must keep resolving to the same
 * schedule. Both titles say which copy they are, since the originals carry the same ones. Their
 * metadata is transcribed from the files rather than derived, so the library can be listed without
 * parsing every schedule up front.
 */
const ANDROID_REDISTRIBUTED: BundledProgram[] = [
  {
    id: 'powernap',
    title: 'Power Nap (Android)',
    category: 'Gnaural',
    author: 'Gnaural',
    description: 'Around 20mn of rest to make it through the day. Put on your headphones and relax!',
    collection: 'android',
    durationSeconds: 1200,
    loops: 1,
    lostAmbientBed: false,
    converted: false,
  },
  {
    id: 'airplanetravelaid',
    title: 'Meditation schedule for airplane travel (Android)',
    category: 'Gnaural',
    author: '@Gnaural',
    description:
      'Designed to make time go faster on flights. Constant declining base frequency, you can relax or read a book at the same time.',
    collection: 'android',
    // 73.5 minutes. PLAN.md §8's fixture table says "~3600 s"; the entries — and the file's own
    // totaltime — say 4410.
    durationSeconds: 4410,
    loops: 1,
    lostAmbientBed: false,
    converted: false,
  },
];

/**
 * Gnaural's own collection, from `fixtures/gnaural/manifest.json` (see its README).
 *
 * Everything here is read out of the files rather than curated, so nothing needs deciding per
 * preset — including `loops`, which the Android set never uses and six of these do. The split into
 * `Official` and `Contributed` follows the `<author>` field and nothing else.
 */
const GNAURAL_PRESETS: BundledProgram[] = gnauralManifest.map((preset) => ({
  id: idFromPath(preset.file),
  title: preset.title,
  category: preset.category,
  author: preset.author,
  description: preset.description,
  collection: 'gnaural',
  durationSeconds: preset.durationSeconds,
  loops: preset.loops,
  lostAmbientBed: false,
  converted: false,
}));

/**
 * `voiceCount` and `sourceMethod` from the manifest are deliberately not carried across.
 * `voiceCount` counts binaural voices only — `hypnosis-self-hypnosis` declares 1 where the file
 * has 2 — which is precisely the stale-declared-count trap PLAN.md §3.4 warns about. Anything
 * countable is derived from the parsed schedule instead.
 */
const PRESETS: BundledProgram[] = manifest.map((preset) => ({
  id: idFromPath(preset.file),
  title: preset.title,
  category: preset.category,
  author: preset.author,
  description: preset.description.trim(),
  collection: 'android',
  durationSeconds: preset.durationSeconds,
  loops: 1,
  lostAmbientBed: preset.backgrounds.includes(AMBIENT_BACKGROUND),
  converted: true,
}));

export const PROGRAMS: BundledProgram[] = [
  ...GNAURAL_PRESETS,
  ...ANDROID_REDISTRIBUTED,
  ...PRESETS,
];

export function programsIn(collection: Collection): BundledProgram[] {
  return PROGRAMS.filter((program) => program.collection === collection);
}

/** Category order for the library view; anything unrecognised sorts to the end alphabetically. */
const CATEGORY_ORDER = [
  'Official',
  'Contributed',
  'Gnaural',
  'Sleep',
  'Meditation',
  'Hypnosis',
  'Healing',
  'Learning',
  'Stimulation',
  'Oobe',
];

/** The manifest's raw category slug is not always presentable. */
const CATEGORY_LABELS: Record<string, string> = {
  Oobe: 'OOBE',
  // Short because these are also the row chips, in a 210px rail: who signed the file, not a
  // sentence about it. The section above them already says which collection this is.
  Official: 'Gnaural',
  Contributed: 'Contrib',
  // Not "Gnaural originals", which is what these used to be called and what they are not: both are
  // Android's *edits* of Gnaural files, and the originals sit in the collection above them
  // (`fixtures/gnaural/README.md`). Not "enhanced" either — Power Nap lost two voices on the way
  // through.
  Gnaural: 'Gnaural edits',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * A colour per category, so forty bundled programs are not forty grey rows.
 *
 * The slot is fixed to the category rather than to its position in the list: a search that filters
 * the library must not repaint what is left of it, and a program's colour is a property of the
 * program. There are ten categories and `SLOT_COUNT` is eight, so the two collections share slots —
 * they are never in the same section, and a category only has to differ from its own siblings.
 */
const CATEGORY_SLOTS: Record<string, number> = {
  Official: 2,
  Contributed: 5,
  Gnaural: 6,
  Sleep: 0,
  Meditation: 2,
  Hypnosis: 4,
  Healing: 5,
  Learning: 3,
  Stimulation: 1,
  Oobe: 7,
};

export function categoryColor(category: string): string {
  const slot = CATEGORY_SLOTS[category];
  return slot === undefined ? 'var(--viz-series-overflow)' : seriesColor(slot);
}

export interface ProgramCategory {
  category: string;
  label: string;
  programs: BundledProgram[];
}

export function programsByCategory(programs: BundledProgram[] = PROGRAMS): ProgramCategory[] {
  const groups = new Map<string, BundledProgram[]>();
  for (const program of programs) {
    const existing = groups.get(program.category);
    if (existing) existing.push(program);
    else groups.set(program.category, [program]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, items]) => ({ category, label: categoryLabel(category), programs: items }));
}

function rank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

export function findProgram(id: string): BundledProgram | undefined {
  return PROGRAMS.find((program) => program.id === id);
}

/**
 * Parse a bundled program's chunk. Warnings come back with it (§3.4) for the same reason they do
 * for an imported file: `powernap.gnaural` carries a stale header — the Android app removed two
 * voices and left the count behind — and `academic-performance-enhancement.gnaural` declares three
 * entries where it has thirty-one. Both are the files as published, not mistakes worth hiding.
 */
export async function loadProgram(id: string): Promise<ParseResult> {
  const path = Object.keys(sources).find((key) => idFromPath(key) === id);
  if (!path) throw new Error(`Unknown program: ${id}`);

  return parseScheduleWithWarnings(await sources[path]());
}
