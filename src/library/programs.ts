import manifest from '../../fixtures/presets/manifest.json';
import type { ParseResult } from '../document/parser';
import { parseScheduleWithWarnings } from '../document/parser';

/**
 * The bundled program library: the 17 converted presets described by
 * `fixtures/presets/manifest.json`, plus the two Gnaural-authored files the manifest does not
 * cover. 19 programs, roughly 14 hours of material.
 *
 * The manifest carries the metadata `.gnaural` has no field for — category and the per-preset
 * attribution — while the `.gnaural` files themselves remain the source of truth for playback.
 * Programs the user imported are separate, in `storage.ts`: they have no category and their
 * metadata is derived from the file rather than curated.
 */
export interface BundledProgram {
  /** Stable id, also the filename stem and the `#/p/<id>` route segment. */
  id: string;
  title: string;
  category: string;
  author: string;
  description: string;
  /** From the manifest, for display in the list before the file is fetched and parsed. */
  durationSeconds: number;
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
 * The two files Gnaural itself produced, which predate the manifest. Their metadata is
 * transcribed from the files rather than derived, so the library can be listed without fetching
 * and parsing all 19 schedules up front.
 */
const GNAURAL_ORIGINALS: BundledProgram[] = [
  {
    id: 'powernap',
    title: 'Power Nap',
    category: 'Gnaural',
    author: 'Gnaural',
    description: 'Around 20mn of rest to make it through the day. Put on your headphones and relax!',
    durationSeconds: 1200,
    lostAmbientBed: false,
    converted: false,
  },
  {
    id: 'airplanetravelaid',
    title: 'Meditation schedule for airplane travel',
    category: 'Gnaural',
    author: '@Gnaural',
    description:
      'Designed to make time go faster on flights. Constant declining base frequency, you can relax or read a book at the same time.',
    // 73.5 minutes. PLAN.md §8's fixture table says "~3600 s"; the entries — and the file's own
    // totaltime — say 4410.
    durationSeconds: 4410,
    lostAmbientBed: false,
    converted: false,
  },
];

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
  durationSeconds: preset.durationSeconds,
  lostAmbientBed: preset.backgrounds.includes(AMBIENT_BACKGROUND),
  converted: true,
}));

export const PROGRAMS: BundledProgram[] = [...GNAURAL_ORIGINALS, ...PRESETS];

/** Category order for the library view; anything unrecognised sorts to the end alphabetically. */
const CATEGORY_ORDER = [
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
  Gnaural: 'Gnaural originals',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
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
 * for an imported file: `powernap.gnaural` is the one program in the library with a stale header,
 * and it is real Gnaural output rather than a mistake worth hiding.
 */
export async function loadProgram(id: string): Promise<ParseResult> {
  const path = Object.keys(sources).find((key) => idFromPath(key) === id);
  if (!path) throw new Error(`Unknown program: ${id}`);

  return parseScheduleWithWarnings(await sources[path]());
}
