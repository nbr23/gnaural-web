import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';
import { saveDraft } from '../library/storage';

// Longer than useSettings's 250ms, since each write serializes the whole document rather than
// storing one number.
export const DRAFT_SAVE_DEBOUNCE_MS = 500;

export interface DraftSaveState {
  pending: boolean;
}

// Autosaves the open draft as serialized XML rather than a JSON blob of the model, so a recovered
// draft is exportable and reopenable in Gnaural desktop by construction. Takes the committed
// document, not an in-flight one — intermediate drag values aren't decisions. A pending write is
// flushed on unmount rather than dropped, since leaving within half a second of an edit is exactly
// what happens when someone finishes typing a title and presses Back.
export function useDraft(
  id: string,
  document: Schedule,
  interval = DRAFT_SAVE_DEBOUNCE_MS,
): DraftSaveState {
  const [pending, setPending] = useState(false);

  // What the database already holds.
  const stored = useRef(document);
  const latest = useRef(document);
  const draftId = useRef(id);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = document;
  draftId.current = id;

  const persist = useCallback(() => {
    timer.current = null;
    if (latest.current === stored.current) return;
    stored.current = latest.current;
    void saveDraft(draftId.current, serializeSchedule(latest.current), latest.current);
  }, []);

  const write = useCallback(() => {
    persist();
    setPending(false);
  }, [persist]);

  useEffect(() => {
    if (document === stored.current) return;
    setPending(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(write, interval);
  }, [document, interval, write]);

  // No `setPending` on the way out: the component is going, and only the write still matters.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      persist();
    },
    [persist],
  );

  return { pending };
}
