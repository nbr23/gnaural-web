import { useCallback, useEffect, useState } from 'react';
import type { Schedule } from '../document/types';
import type { ImportedProgram } from './storage';
import { importProgram, listImported, removeImported } from './storage';

export interface Library {
  /** Null until the first read of IndexedDB settles, so the list can hold off rather than flash. */
  imported: ImportedProgram[] | null;
  add(sourceName: string, text: string, schedule: Schedule): Promise<ImportedProgram>;
  remove(id: string): Promise<void>;
}

/**
 * The user's own programs, mirrored from IndexedDB into React state.
 *
 * The mirror is the whole point: the library list, the player's byline and the route resolver all
 * read the same array, so an import or a delete is one write and one re-render rather than three
 * components each querying the database.
 */
export function useLibrary(): Library {
  const [imported, setImported] = useState<ImportedProgram[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listImported().then((programs) => {
      if (!cancelled) setImported(programs);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const add = useCallback(async (sourceName: string, text: string, schedule: Schedule) => {
    const program = await importProgram(sourceName, text, schedule);
    setImported(await listImported());
    return program;
  }, []);

  const remove = useCallback(async (id: string) => {
    await removeImported(id);
    setImported(await listImported());
  }, []);

  return { imported, add, remove };
}
