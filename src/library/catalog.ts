import { formatDuration } from '../app/format';
import type { Route } from '../app/routing';
import { formatHash } from '../app/routing';
import type { BundledProgram, Collection } from './programs';
import { PROGRAMS, categoryBadge, categoryColor, programsByCategory } from './programs';
import type { Draft, ImportedProgram } from './storage';

/**
 * The library's section model (PLAN.md §5.1's program list, grown up).
 *
 * Pure, and deliberately outside the view: what belongs in which section, what a search matches,
 * how a favourite is keyed and which disclaimer a program owes are all rules rather than markup,
 * and all four are easier to get wrong than to render. The view walks whatever comes back.
 */

/** Where a program came from, which is the library's colour key and its top-level grouping. */
export type Origin = 'draft' | 'mine' | 'imported' | 'gnaural' | 'android' | 'brainmachine';

export const ORIGIN_LABELS: Record<Origin, string> = {
  draft: 'Draft',
  mine: 'Made here',
  imported: 'Imported',
  gnaural: 'Gnaural',
  android: 'Android',
  brainmachine: 'Brain Machine',
};

export interface LibraryItem {
  /** `formatHash(route)` — the row's React key, its favourite key, and where it navigates. */
  key: string;
  route: Route;
  title: string;
  /** Length and credit, as one line: "20 min · Gnaural". */
  meta: string;
  origin: Origin;
  /** What the row's chip says: a bundled program's category, or where anything else came from. */
  badge: string;
  /**
   * The row's colour, as a CSS custom-property reference. Set for a bundled program, which takes
   * its category's colour; anything else falls back to the colour of its origin.
   */
  accent?: string;
  /** Free text this program is searched on beyond its title — its credit and description. */
  searchText: string;
  /** A disclaimer that applies to this program alone. */
  note?: string;
  /** What removing this row means. Absent for a bundled program, which cannot be removed. */
  removable?: 'imported' | 'draft';
}

/** One run of a section's disclaimer: plain prose, the clause it turns on, or a link out. */
export interface NoteSegment {
  text: string;
  strong?: boolean;
  href?: string;
}

export interface LibrarySection {
  /** Stable across renders and searches — the rail scrolls to it and the settings remember it. */
  id: string;
  label: string;
  /** A short form of `label` for the jump rail, where the column is 210px wide. */
  railLabel?: string;
  /** A disclaimer that applies to everything in the section. */
  note?: NoteSegment[];
  items: LibraryItem[];
  /** A leading package or file name in `label`, set as typed rather than uppercased like prose. */
  code?: string;
  /** The colour of what this section holds — a category's, on the sub-sections that have one. */
  accent?: string;
  /** Sub-sections, which is how the Android library keeps its own categories. */
  children?: LibrarySection[];
}

export interface CatalogInput {
  /** Null while IndexedDB is still being read; the section holds off rather than flashing empty. */
  imported: ImportedProgram[] | null;
  drafts: Draft[] | null;
  favourites: readonly string[];
  /** Free-text filter. Empty shows everything. */
  query?: string;
  bundled?: BundledProgram[];
}

/**
 * Where the bundled library came from — three collections, credited separately.
 *
 * The attribution used to sit at the bottom of the page, where it described everything above it
 * without saying so, and then described *everything* as the Android app's when two of the programs
 * predate it by two years. It belongs on the group it is about — and §2's no-medical-claims rule is
 * met by whose words these are, which is only clear if the words and the credit are in the same
 * place.
 */
export const ANDROID_PACKAGE = 'com.ihunda.android.binauralbeat';

const ANDROID_APP = 'Binaural Beats Therapy';
const ANDROID_LISTING = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

const ANDROID_NOTE: NoteSegment[] = [
  { text: 'From the Android app ' },
  { text: ANDROID_APP, href: ANDROID_LISTING },
  { text: '. ' },
  {
    text:
      "The titles and descriptions are their original authors' words, not claims made by this app",
    strong: true,
  },
  {
    text:
      '; the converted presets play the frequencies they always did, without their ambient ' +
      'backgrounds or the old player’s fades between periods.',
  },
];

const GNAURAL_PRESETS_URL = 'https://sourceforge.net/projects/gnaural/files/Presets/';

const GNAURAL_NOTE: NoteSegment[] = [
  { text: 'From ' },
  { text: 'the Gnaural project', href: GNAURAL_PRESETS_URL },
  { text: ', Bret Logan’s original desktop app, published between 2009 and 2020 and shipped here ' },
  { text: 'unmodified', strong: true },
  {
    text:
      '. Seven are Gnaural’s own and fourteen were contributed to the project by other people, ' +
      'each credited as they signed it; the titles and descriptions are their words, not claims ' +
      'made by this app. Two of these are the originals of files the Android app below ' +
      'redistributed after editing them.',
  },
];

const BRAIN_MACHINE_KIT = 'https://github.com/maltman23/Brain_Machine_kit';

const BRAIN_MACHINE_NOTE: NoteSegment[] = [
  { text: 'The three brainwave tables of ' },
  { text: 'Mitch Altman’s Brain Machine kit. ', href: BRAIN_MACHINE_KIT },
  { text: 'The lights are not reproduced: this is the sound half only' },
  {
    text:
      ', and the sequences were designed to be heard and seen at once. Their descriptions are the ' +
      'kit’s own words, not claims made by this app. CC BY-SA 4.0.',
  },
];

/** `fixtures/presets/README.md`: four presets used a sampled ambient loop that was left behind. */
const LOST_BED_NOTE = 'Ambient background not carried over — the app’s noise layer stands in for it.';

export function buildCatalog({
  imported,
  drafts,
  favourites,
  query = '',
  bundled = PROGRAMS,
}: CatalogInput): LibrarySection[] {
  const draftItems = (drafts ?? []).map(draftItem);
  const importedItems = imported ?? [];
  const mine = importedItems.filter((program) => program.origin === 'authored').map(importedItem);
  const brought = importedItems.filter((program) => program.origin !== 'authored').map(importedItem);

  const gnaural: LibrarySection = {
    id: 'gnaural',
    label: 'Gnaural presets',
    railLabel: 'gnaural',
    note: GNAURAL_NOTE,
    items: [],
    children: collectionSections('gnaural', bundled),
  };

  const android: LibrarySection = {
    // The id is persisted in `Settings.collapsed`, so it outlives whatever the label says.
    id: 'android',
    label: `${ANDROID_PACKAGE} presets`,
    railLabel: 'binauralbeat',
    code: ANDROID_PACKAGE,
    note: ANDROID_NOTE,
    items: [],
    children: collectionSections('android', bundled),
  };

  // Flat, unlike the two collections above: three programs in three categories would be three
  // sub-sections of one row each, which is more heading than library.
  const brainMachine: LibrarySection = {
    id: 'brainmachine',
    label: 'Brain Machine sequences',
    railLabel: 'brain machine',
    note: BRAIN_MACHINE_NOTE,
    items: bundled
      .filter((program) => program.collection === 'brainmachine')
      .map(bundledItem),
  };

  const sections: LibrarySection[] = [
    { id: 'drafts', label: 'Drafts', items: draftItems },
    { id: 'mine', label: 'Made here', items: mine },
    { id: 'imported', label: 'Imported', items: brought },
    gnaural,
    android,
    brainMachine,
  ];

  // Favourites lead, and are a *view* of the sections below rather than a place a program moves to:
  // starring something must not take it out of the group it belongs to, or unstarring it would look
  // like a deletion. The order is the one the user starred them in.
  const byKey = new Map(allItems(sections).map((item) => [item.key, item]));
  const starred = favourites
    .map((key) => byKey.get(key))
    .filter((item): item is LibraryItem => item !== undefined);

  if (starred.length > 0) {
    sections.unshift({ id: 'favourites', label: 'Favourites', items: starred });
  }

  // A heading reading "Drafts 0" is a heading in the way: on a fresh install three of these are
  // empty, which is 150 px of nothing above the first program and three dead entries in the rail.
  return filterSections(sections, query.trim().toLowerCase()).filter(nonEmpty);
}

/**
 * One sub-section per category within a collection. The id keeps its collection prefix because
 * `Settings.collapsed` persists it, and each collection has categories of its own.
 */
function collectionSections(
  collection: Collection,
  bundled: readonly BundledProgram[],
): LibrarySection[] {
  const programs = bundled.filter((program) => program.collection === collection);

  return programsByCategory(programs).map((group) => ({
    id: `${collection}-${group.category.toLowerCase()}`,
    label: group.label,
    railLabel: categoryBadge(group.category),
    accent: categoryColor(group.category),
    items: group.programs.map(bundledItem),
  }));
}

function nonEmpty(section: LibrarySection): boolean {
  return section.items.length > 0 || (section.children ?? []).some(nonEmpty);
}

/** Every item in a section tree, in reading order. */
export function allItems(sections: readonly LibrarySection[]): LibraryItem[] {
  return sections.flatMap((section) => [...section.items, ...allItems(section.children ?? [])]);
}

/**
 * Drop what does not match, then drop whatever is left empty — including a parent whose every child
 * emptied, so the rail can be built from the same tree and cannot offer a section that is not
 * there. An empty query returns the tree unchanged, identity and all.
 */
function filterSections(sections: LibrarySection[], query: string): LibrarySection[] {
  if (!query) return sections;

  return sections.flatMap((section) => {
    const items = section.items.filter((item) => matches(item, query));
    const children = filterSections(section.children ?? [], query);
    if (items.length === 0 && children.length === 0) return [];

    return [{ ...section, items, children: section.children ? children : undefined }];
  });
}

function matches(item: LibraryItem, query: string): boolean {
  return (
    item.title.toLowerCase().includes(query) || item.searchText.toLowerCase().includes(query)
  );
}

function bundledItem(program: BundledProgram): LibraryItem {
  const route: Route = { view: 'program', id: program.id };
  return {
    key: formatHash(route),
    route,
    title: program.title,
    meta: metaLine(program.durationSeconds, program.author, program.loops),
    origin: program.collection,
    // Its category rather than its origin: the section these rows sit in already says where the
    // whole set came from, so the chip can say the thing the row does not otherwise carry.
    badge: categoryBadge(program.category),
    accent: categoryColor(program.category),
    searchText: `${program.author} ${program.description}`,
    note: program.lostAmbientBed ? LOST_BED_NOTE : undefined,
  };
}

function importedItem(program: ImportedProgram): LibraryItem {
  const route: Route = { view: 'imported', id: program.id };
  const origin: Origin = program.origin === 'authored' ? 'mine' : 'imported';
  return {
    key: formatHash(route),
    route,
    title: program.title,
    // The file it came from, since an imported program often has no author of its own.
    meta: metaLine(program.durationSeconds, program.author || program.sourceName),
    origin,
    badge: ORIGIN_LABELS[origin],
    searchText: `${program.author} ${program.sourceName} ${program.description}`,
    removable: 'imported',
  };
}

function draftItem(draft: Draft): LibraryItem {
  const route: Route = { view: 'editor', id: draft.id };
  return {
    key: formatHash(route),
    route,
    title: draft.title,
    // Where it was forked from. A draft has no author until someone gives it one.
    meta: metaLine(draft.durationSeconds, `from ${draft.sourceName}`),
    origin: 'draft',
    badge: ORIGIN_LABELS.draft,
    searchText: draft.sourceName,
    removable: 'draft',
  };
}

function metaLine(durationSeconds: number, credit: string, loops = 1): string {
  // "0.8 s" for a schedule that repeats 8000 times is not its length. How many passes actually play
  // is the engine's answer (`passCount` bounds what a file declares), so the row says only that it
  // repeats and leaves the count to the player.
  const length = loops === 1 ? formatDuration(durationSeconds) : `${formatDuration(durationSeconds)} loop`;

  // One bundled preset is uncredited upstream; the rest carry a credit that must not be dropped
  // (fixtures/presets/README.md).
  return credit ? `${length} · ${credit}` : length;
}
