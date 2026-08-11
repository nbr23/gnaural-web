import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';
import { saveDraft } from '../library/storage';

/**
 * How long edits settle before they are written.
 *
 * Longer than `useSettings`'s 250 ms, because each write serializes the whole document rather than
 * storing one number, and typing a title is a longer burst than dragging a slider. Still short
 * enough that §6.1's "losing a half-hour of authoring to a tab close is unacceptable" is met by a
 * wide margin.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 500;

export interface DraftSaveState {
  /** A change is waiting to be written. What the editor shows as "Saving…". */
  pending: boolean;
}

/**
 * Autosave for the open draft (§6.1).
 *
 * **Serialized XML, not a JSON blob of the model.** The round-trip is a proven fixed point, so a
 * recovered draft is exportable and reopenable in Gnaural desktop by definition, and there is no
 * second representation that could drift from the first.
 *
 * Given the *committed* document rather than an in-flight one: a draft records what the user
 * decided, and once dragging exists the intermediate values of a gesture are not decisions.
 *
 * A pending write is flushed on unmount rather than dropped — the same rule `useSettings` follows,
 * and for a stronger reason: leaving the editor within half a second of an edit is exactly what
 * someone does when they finish typing a title and press Back.
 */
export function useDraft(
  id: string,
  document: Schedule,
  interval = DRAFT_SAVE_DEBOUNCE_MS,
): DraftSaveState {
  const [pending, setPending] = useState(false);

  /** What the database already holds. Starts at the document the editor opened with. */
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
