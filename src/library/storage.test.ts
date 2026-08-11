import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { serializeSchedule } from '../document/serializer';
import { loadFixture } from '../document/test-fixtures';
import { resetDatabase } from '../test-setup';
import {
  createDraft,
  getDraft,
  getImported,
  importProgram,
  listDrafts,
  listImported,
  loadSettings,
  removeDraft,
  removeImported,
  saveDraft,
  saveSetting,
} from './storage';

const POWERNAP = loadFixture('powernap.gnaural');
const AIRPLANE = loadFixture('airplanetravelaid.gnaural');

function importFixture(name: string, text: string) {
  return importProgram(name, text, parseSchedule(text));
}

beforeEach(resetDatabase);

describe('imported programs', () => {
  it('stores a program with metadata derived from the schedule', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);

    expect(program.title).toBe('Power Nap');
    expect(program.author).toBe('Gnaural');
    expect(program.sourceName).toBe('powernap.gnaural');
    // The shortest voice (§3.7), which for this single-voice file is the whole thing.
    expect(program.durationSeconds).toBeCloseTo(1200, 5);
    expect(await getImported(program.id)).toEqual(program);
  });

  it('keeps the original text rather than re-serialized XML', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);

    expect(program.text).toBe(POWERNAP);
  });

  it('lists the most recently imported first', async () => {
    const first = await importFixture('powernap.gnaural', POWERNAP);
    const second = await importFixture('airplanetravelaid.gnaural', AIRPLANE);

    expect((await listImported()).map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it('returns the existing entry when the same text is imported again', async () => {
    const first = await importFixture('powernap.gnaural', POWERNAP);
    const again = await importFixture('a-different-name.gnaural', POWERNAP);

    expect(again.id).toBe(first.id);
    expect(again.sourceName).toBe('powernap.gnaural');
    expect(await listImported()).toHaveLength(1);
  });

  it('removes a program', async () => {
    const program = await importFixture('powernap.gnaural', POWERNAP);
    await removeImported(program.id);

    expect(await listImported()).toHaveLength(0);
    expect(await getImported(program.id)).toBeUndefined();
  });

  it('falls back to the filename when a schedule has no title', async () => {
    const untitled = POWERNAP.replace('<title>Power Nap</title>', '<title></title>');
    const program = await importFixture('mystery.gnaural', untitled);

    expect(program.title).toBe('mystery.gnaural');
  });
});

describe('drafts', () => {
  const schedule = parseSchedule(POWERNAP);

  it('forks a document into a draft with metadata derived from it', async () => {
    const draft = await createDraft('Power Nap', POWERNAP, schedule);

    expect(draft.title).toBe('Power Nap');
    expect(draft.sourceName).toBe('Power Nap');
    expect(draft.xml).toBe(POWERNAP);
    expect(draft.durationSeconds).toBeCloseTo(1200, 5);
    expect(await getDraft(draft.id)).toEqual(draft);
  });

  /** Two copies of the same program is how someone tries two ideas — the import dedupe is wrong here. */
  it('does not dedupe identical forks', async () => {
    const first = await createDraft('Power Nap', POWERNAP, schedule);
    const second = await createDraft('Power Nap', POWERNAP, schedule);

    expect(second.id).not.toBe(first.id);
    expect(await listDrafts()).toHaveLength(2);
  });

  it('saves edited XML and re-derives the display metadata from it', async () => {
    const draft = await createDraft('Power Nap', POWERNAP, schedule);
    const renamed = { ...schedule, title: 'Nap, shorter' };
    await saveDraft(draft.id, serializeSchedule(renamed), renamed);

    const saved = await getDraft(draft.id);
    expect(saved?.title).toBe('Nap, shorter');
    expect(parseSchedule(saved?.xml ?? '').title).toBe('Nap, shorter');
    expect(saved?.createdAt).toBe(draft.createdAt);
  });

  /** A draft deleted while its editor is open must not be resurrected by the next autosave. */
  it('does not recreate a draft that has been removed', async () => {
    const draft = await createDraft('Power Nap', POWERNAP, schedule);
    await removeDraft(draft.id);
    await saveDraft(draft.id, POWERNAP, schedule);

    expect(await getDraft(draft.id)).toBeUndefined();
    expect(await listDrafts()).toHaveLength(0);
  });

  it('lists the most recently edited first', async () => {
    const first = await createDraft('one', POWERNAP, schedule);
    const second = await createDraft('two', POWERNAP, schedule);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await saveDraft(first.id, POWERNAP, schedule);

    expect((await listDrafts()).map((d) => d.id)).toEqual([first.id, second.id]);
  });

  /**
   * The upgrade path, which is the part that can lose data rather than just fail: every existing
   * install is at version 1, and an unconditional `createObjectStore` would throw `ConstraintError`
   * and take the whole library with it.
   */
  it('adds the drafts store to an existing version 1 database without touching what is there', async () => {
    const v1 = await openDB('gnaural-web', 1, {
      upgrade(database) {
        database.createObjectStore('programs', { keyPath: 'id' });
        database.createObjectStore('settings');
      },
    });
    await v1.put('programs', { id: 'kept', text: POWERNAP, title: 'Power Nap' }, undefined);
    await v1.put('settings', 0.4, 'masterGain');
    v1.close();

    const draft = await createDraft('Power Nap', POWERNAP, schedule);

    expect(await getDraft(draft.id)).toBeDefined();
    expect((await listImported()).map((program) => program.id)).toEqual(['kept']);
    expect(await loadSettings()).toEqual({ masterGain: 0.4 });
  });
});

describe('settings', () => {
  it('starts empty so callers fall back to their own defaults', async () => {
    expect(await loadSettings()).toEqual({});
  });

  it('round-trips every setting it is given', async () => {
    await saveSetting('masterGain', 0.4);
    await saveSetting('exportSampleRate', 22050);
    await saveSetting('wakeLock', true);

    expect(await loadSettings()).toEqual({
      masterGain: 0.4,
      exportSampleRate: 22050,
      wakeLock: true,
    });
  });

  it('overwrites a setting rather than accumulating values', async () => {
    await saveSetting('masterGain', 0.4);
    await saveSetting('masterGain', 0.9);

    expect(await loadSettings()).toEqual({ masterGain: 0.9 });
  });
});
