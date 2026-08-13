import { useCallback, useEffect, useState } from 'react';
import type { Schedule } from '../document/types';
import type { Draft, ImportedProgram, ProgramOrigin } from './storage';
import {
  createDraft,
  importProgram,
  listDrafts,
  listImported,
  removeDraft,
  removeImported,
} from './storage';

export interface Library {
  /** Null until the first read of IndexedDB settles, so the list can hold off rather than flash. */
  imported: ImportedProgram[] | null;
  /** Drafts being authored (§6.1), most recently edited first. Null until the read settles. */
  drafts: Draft[] | null;
  add(
    sourceName: string,
    text: string,
    schedule: Schedule,
    origin?: ProgramOrigin,
  ): Promise<ImportedProgram>;
  remove(id: string): Promise<void>;
  /** Copy a document into a new draft — the editor never edits a program in place. */
  fork(sourceName: string, xml: string, schedule: Schedule): Promise<Draft>;
  discard(id: string): Promise<void>;
  /**
   * Re-read the drafts.
   *
   * The mirror cannot see the editor's autosave, which writes straight to IndexedDB on a debounce
   * — pushing every keystroke through here instead would re-render the library behind the editor
   * for no one's benefit. So the list is refreshed when it is about to be looked at.
   */
  reloadDrafts(): Promise<void>;
}

/**
 * The user's own programs and drafts, mirrored from IndexedDB into React state.
 *
 * The mirror is the whole point: the library list, the player's byline and the route resolver all
 * read the same array, so an import or a delete is one write and one re-render rather than three
 * components each querying the database.
 */
export function useLibrary(): Library {
  const [imported, setImported] = useState<ImportedProgram[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listImported(), listDrafts()]).then(([programs, authored]) => {
      if (cancelled) return;
      setImported(programs);
      setDrafts(authored);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const add = useCallback(
    async (sourceName: string, text: string, schedule: Schedule, origin?: ProgramOrigin) => {
      const program = await importProgram(sourceName, text, schedule, origin);
      setImported(await listImported());
      return program;
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    await removeImported(id);
    setImported(await listImported());
  }, []);

  const reloadDrafts = useCallback(async () => {
    setDrafts(await listDrafts());
  }, []);

  const fork = useCallback(
    async (sourceName: string, xml: string, schedule: Schedule) => {
      const draft = await createDraft(sourceName, xml, schedule);
      await reloadDrafts();
      return draft;
    },
    [reloadDrafts],
  );

  const discard = useCallback(
    async (id: string) => {
      await removeDraft(id);
      await reloadDrafts();
    },
    [reloadDrafts],
  );

  return { imported, drafts, add, remove, fork, discard, reloadDrafts };
}
