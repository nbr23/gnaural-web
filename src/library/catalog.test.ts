import { describe, expect, it } from 'vitest';
import { ANDROID_PACKAGE, buildCatalog } from './catalog';
import type { LibrarySection } from './catalog';
import { PROGRAMS, categoryColor } from './programs';
import type { Draft, ImportedProgram, ProgramOrigin } from './storage';

function imported(id: string, title: string, origin?: ProgramOrigin): ImportedProgram {
  return {
    id,
    text: '<schedule/>',
    sourceName: `${id}.gnaural`,
    origin,
    title,
    author: 'Someone',
    description: 'A program that came from somewhere.',
    durationSeconds: 1200,
    importedAt: 1,
  };
}

function draft(id: string, title: string): Draft {
  return {
    id,
    xml: '<schedule/>',
    title,
    sourceName: 'Power Nap',
    durationSeconds: 600,
    createdAt: 1,
    updatedAt: 1,
  };
}

function section(sections: LibrarySection[], id: string): LibrarySection | undefined {
  return sections.find((candidate) => candidate.id === id);
}

const EMPTY = { imported: null, drafts: null, favourites: [] };

describe('buildCatalog', () => {
  it('leads with the user’s own work and ends with the bundled library', () => {
    const sections = buildCatalog({
      imported: [imported('a', 'Kept from live', 'authored'), imported('b', 'Dropped in')],
      drafts: [draft('d', 'Half-finished')],
      favourites: [],
    });

    expect(sections.map((each) => each.id)).toEqual([
      'drafts',
      'mine',
      'imported',
      'gnaural',
      'android',
      'brainmachine',
    ]);
  });

  it('shows nothing but the bundled library on a fresh install', () => {
    // Three empty headings are three headings in the way, and three dead entries in the rail.
    expect(buildCatalog(EMPTY).map((each) => each.id)).toEqual([
      'gnaural',
      'android',
      'brainmachine',
    ]);
  });

  it('separates what was made here from what was brought in', () => {
    const sections = buildCatalog({
      imported: [
        imported('a', 'Kept from live', 'authored'),
        imported('b', 'Dropped in', 'file'),
        imported('c', 'From a link', 'link'),
        // Written before the field existed: those all arrived as a file or a link.
        imported('d', 'From before'),
      ],
      drafts: [],
      favourites: [],
    });

    expect(section(sections, 'mine')?.items.map((item) => item.title)).toEqual(['Kept from live']);
    expect(section(sections, 'imported')?.items.map((item) => item.title)).toEqual([
      'Dropped in',
      'From a link',
      'From before',
    ]);
  });

  it('groups the bundled programs under the collection they came from, by category', () => {
    const sections = buildCatalog(EMPTY);
    const gnaural = section(sections, 'gnaural');
    const android = section(sections, 'android');

    expect(android?.items).toHaveLength(0);
    // The heading names the app rather than gesturing at it, and the view sets `code` in mono.
    expect(android?.label).toBe(`${ANDROID_PACKAGE} presets`);
    expect(android?.code).toBe(ANDROID_PACKAGE);
    expect(android?.children?.[0].label).toBe('Sleep');
    expect(gnaural?.children?.map((child) => child.label)).toEqual(['Gnaural', 'Contrib']);

    // The Brain Machine's three are flat: one row each under Meditation, Sleep and Gamma would be
    // three headings for three programs.
    const brainMachine = section(sections, 'brainmachine');
    expect(brainMachine?.children).toBeUndefined();
    expect(brainMachine?.items.map((item) => item.badge)).toEqual(['Meditation', 'Sleep', 'Gamma']);

    // Between them the three sections hold the whole bundled library and nothing twice.
    const rows = [gnaural, android, brainMachine].flatMap((each) => [
      ...(each?.items ?? []),
      ...(each?.children?.flatMap((child) => child.items) ?? []),
    ]);
    expect(rows).toHaveLength(PROGRAMS.length);
    expect(new Set(rows.map((row) => row.key)).size).toBe(PROGRAMS.length);
  });

  it('spells a category out in its heading and abbreviates it on the chip and the rail', () => {
    const oobe = section(buildCatalog(EMPTY), 'android')?.children?.find(
      (child) => child.id === 'android-oobe',
    );

    expect(oobe?.label).toBe('Out of body experience');
    expect(oobe?.railLabel).toBe('OOBE');
    expect(new Set(oobe?.items.map((item) => item.badge))).toEqual(new Set(['OOBE']));
  });

  it('credits each collection where its programs are, not once at the foot of the page', () => {
    const sections = buildCatalog(EMPTY);

    // §2 is met by the clause in bold, and what each note credits is a link rather than prose.
    const android = section(sections, 'android')?.note ?? [];
    expect(android.find((segment) => segment.strong)?.text).toContain("original authors' words");
    expect(android.find((segment) => segment.href)?.href).toContain(ANDROID_PACKAGE);

    const gnaural = section(sections, 'gnaural')?.note ?? [];
    expect(gnaural.find((segment) => segment.strong)?.text).toBe('unmodified');
    expect(gnaural.find((segment) => segment.href)?.href).toContain('sourceforge.net/projects/gnaural');

    // The Brain Machine is half a light show, and the note says which half this is.
    const brainMachine = section(sections, 'brainmachine')?.note ?? [];
    expect(brainMachine.map((segment) => segment.text).join('')).toContain('sound half only');
    expect(brainMachine.find((segment) => segment.href)?.href).toContain('Brain_Machine_kit');
  });

  it('keys a bundled program to its category and everything else to its origin', () => {
    const sections = buildCatalog({ ...EMPTY, imported: [imported('a', 'Dropped in')] });
    const meditation = section(sections, 'android')?.children?.find(
      (child) => child.label === 'Meditation',
    );
    const [brought] = section(sections, 'imported')?.items ?? [];

    expect(meditation?.accent).toBe(categoryColor('Meditation'));
    expect(meditation?.items[0].badge).toBe('Meditation');
    expect(meditation?.items[0].accent).toBe(categoryColor('Meditation'));

    // Nothing imported has a category, so its row keeps the origin colour the CSS gives it.
    expect(brought.badge).toBe('Imported');
    expect(brought.accent).toBeUndefined();
  });

  it('carries the conversion disclaimer on the programs it applies to', () => {
    const android = section(buildCatalog(EMPTY), 'android');
    const items = android?.children?.flatMap((child) => child.items) ?? [];

    // `fixtures/presets/README.md`: four presets used a sampled ambient loop that was dropped.
    const noted = items.filter((item) => item.note !== undefined);
    expect(noted).toHaveLength(4);
    expect(noted[0].note).toContain('noise layer');
    expect(items.find((item) => item.title === 'Power Nap (Android)')?.note).toBeUndefined();
  });

  it('shows favourites first without moving them out of their own section', () => {
    const sections = buildCatalog({ ...EMPTY, favourites: ['#/p/powernap'] });
    const favourites = section(sections, 'favourites');

    expect(sections[0].id).toBe('favourites');
    expect(favourites?.items.map((item) => item.title)).toEqual(['Power Nap (Android)']);
    expect(
      section(sections, 'android')?.children?.flatMap((child) => child.items),
    ).toHaveLength(PROGRAMS.filter((program) => program.collection === 'android').length);
  });

  it('ignores a favourite whose program is gone', () => {
    // Removing an import does not prune the list — one that comes back keeps its star — so the
    // key has to be tolerated here rather than assumed to resolve.
    const sections = buildCatalog({ ...EMPTY, favourites: ['#/i/deleted-long-ago'] });

    expect(section(sections, 'favourites')).toBeUndefined();
  });

  it('searches titles, credits and descriptions, and drops what empties', () => {
    const sections = buildCatalog({ ...EMPTY, query: 'schumann' });
    const android = section(sections, 'android');

    expect(sections).toHaveLength(1);
    expect(android?.children?.map((child) => child.label)).toEqual(['Meditation']);
    expect(android?.children?.[0].items.map((item) => item.title)).toEqual(['Schumann Resonance']);

    // The description is searched too — this phrase is in `meditation-unity`'s prose alone.
    expect(
      section(buildCatalog({ ...EMPTY, query: 'without bounds' }), 'android')
        ?.children?.flatMap((child) => child.items)
        .map((item) => item.title),
    ).toEqual(['Unity']);
  });

  it('returns nothing at all when a search matches nothing', () => {
    expect(buildCatalog({ ...EMPTY, query: 'no such program' })).toEqual([]);
  });

  it('keys every row by its route, which is what a favourite stores', () => {
    const sections = buildCatalog({
      imported: [imported('abc', 'Dropped in')],
      drafts: [draft('def', 'Half-finished')],
      favourites: [],
    });

    expect(section(sections, 'imported')?.items[0].key).toBe('#/i/abc');
    expect(section(sections, 'drafts')?.items[0].key).toBe('#/e/def');
    expect(section(sections, 'android')?.children?.[0].items[0].key).toBe('#/p/powernap');
  });

  it('says how long each program runs, and who to credit', () => {
    const sections = buildCatalog(EMPTY);
    const powernap = section(sections, 'android')?.children?.[0].items[0];
    const own = section(sections, 'gnaural')?.children?.[0];

    expect(powernap?.meta).toBe('20 min · Gnaural');
    // A schedule that repeats is not as long as one pass of it, and how many passes actually play
    // is the engine's answer rather than the file's — so the row says only that it loops.
    expect(own?.items.find((item) => item.title.startsWith('8-Voice'))?.meta).toBe(
      '1 s loop · Gnaural',
    );
  });
});
